import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { AuthRejection } from "../src/auth/jwt";
import { authKeysDir, createAuthRegistry } from "../src/auth/registry";
import { createTokenVerifier } from "../src/auth/verifier";
import { signAndRecord } from "../src/cli/commands/token-mint";
import { provisionAuthDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { createMetricsApp } from "../src/metrics/endpoint";
import { startHttp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

function fixture() {
  const db = openMemoryDb();
  provisionAuthDb(db);
  const dir = makeTempDir("auth-registry-");
  dirs.push(dir);
  const registry = createAuthRegistry(db, { configSecret: SECRET, keysDir: authKeysDir(dir) });
  return { db, dir, registry };
}

const claims = (over: Record<string, unknown> = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: "agent-1",
    scopes: ["read:notes", "admin:metrics"],
    iat: now,
    exp: now + 3600,
    ...over,
  };
};

async function reasonOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AuthRejection) return e.reason;
    throw e;
  }
  return "accepted";
}

describe("token revocation", () => {
  it("mint -> verify ok -> revoke -> verify fails token_revoked (unexpired)", async () => {
    const { registry } = fixture();
    const verifier = createTokenVerifier({ secret: SECRET, registry });
    const token = await signAndRecord(registry, claims());

    const id = await verifier.verify(token);
    expect(id.caller).toBe("agent-1");
    expect(id.jti).toBeTypeOf("string");

    expect(registry.revoke(id.jti as string, "laptop lost")).toBe("revoked");
    expect(await reasonOf(verifier.verify(token))).toBe("token_revoked");
  });

  it("a revoked jti stays revoked and a second revoke is a no-op", async () => {
    const { registry } = fixture();
    const token = await signAndRecord(registry, claims());
    const jti = JSON.parse(Buffer.from(token.split(".")[1] as string, "base64url").toString()).jti;
    expect(registry.revoke(jti, "first")).toBe("revoked");
    expect(registry.revoke(jti, "second")).toBe("already_revoked");
    const row = registry.listTokens().find((t) => t.jti === jti);
    expect(row?.revokedReason).toBe("first");
    expect(registry.revoke("no-such-jti", null)).toBe("tombstoned");
  });

  it("revocation written on one connection is seen by another process on its next request", async () => {
    const db = openMemoryDb();
    provisionAuthDb(db);
    const a = createAuthRegistry(db, { configSecret: SECRET });
    // A second registry object over the same database stands in for a second process: nothing is
    // cached in-process, so its very next lookup must observe the write.
    const b = createAuthRegistry(db, { configSecret: SECRET });
    const verifierB = createTokenVerifier({ secret: SECRET, registry: b });
    const token = await signAndRecord(a, claims());
    await verifierB.verify(token);
    a.revoke(
      JSON.parse(Buffer.from(token.split(".")[1] as string, "base64url").toString()).jti,
      null,
    );
    expect(await reasonOf(verifierB.verify(token))).toBe("token_revoked");
  });

  it("a token with no jti (minted before the registry) still verifies", async () => {
    const { registry } = fixture();
    const verifier = createTokenVerifier({ secret: SECRET, registry });
    const legacy = await new SignJWT(claims())
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode(SECRET));
    expect((await verifier.verify(legacy)).caller).toBe("agent-1");
  });

  it("the JWKS path checks jti too, but only for a jti our registry holds", async () => {
    const { registry } = fixture();
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "ext-1", alg: "ES256" };
    const verifier = createTokenVerifier({ jwks: { keys: [jwk] }, registry });
    const sign = (jti: string) =>
      new SignJWT({ ...claims(), jti })
        .setProtectedHeader({ alg: "ES256", kid: "ext-1" })
        .sign(privateKey);
    registry.recordToken({
      jti: "ours",
      kid: "ext-1",
      sub: "agent-1",
      scopesSummary: "",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    registry.revoke("ours", "test");
    expect(await reasonOf(verifier.verify(await sign("ours")))).toBe("token_revoked");
    expect(await reasonOf(verifier.verify(await sign("someone-elses")))).toBe("accepted");
  });

  it("fails closed when the registry tables are missing", async () => {
    const db = openMemoryDb();
    const registry = createAuthRegistry(db, { configSecret: SECRET });
    const verifier = createTokenVerifier({ secret: SECRET, registry });
    const token = await new SignJWT(claims({ jti: "x" }))
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode(SECRET));
    await expect(verifier.verify(token)).rejects.toThrow();
  });
});

describe("revocation over the HTTP edge and /metrics", () => {
  async function boot(registryDb: ReturnType<typeof fixture>) {
    const parsed = ServerConfigSchema.parse({
      vaults: [{ id: "main", path: "/tmp/main" }],
      auth: { mode: "jwt", jwtSecret: SECRET, audience: "http://test", tokenTtlSeconds: 3600 },
    });
    const rejections: string[] = [];
    const handle = await startHttp({
      name: "obsidian-tc",
      version: "0.0.0-test",
      registry: new ToolRegistry(),
      auth: parsed.auth,
      db: registryDb.db,
      authRegistry: registryDb.registry,
      vaultId: "main",
      acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
      host: "127.0.0.1",
      port: 0,
      onAuthRejected: (d) => rejections.push(d.reason),
    });
    return { handle, rejections, parsed };
  }
  const post = (port: number, jwt: string) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

  it("401 with reason token_revoked once revoked, while the same token was accepted before", async () => {
    const fx = fixture();
    const { handle, rejections } = await boot(fx);
    try {
      const token = await signAndRecord(fx.registry, claims({ aud: "http://test" }));
      expect((await post(handle.port, token)).status).not.toBe(401);
      const jti = JSON.parse(
        Buffer.from(token.split(".")[1] as string, "base64url").toString(),
      ).jti;
      fx.registry.revoke(jti, "compromised");
      const res = await post(handle.port, token);
      expect(res.status).toBe(401);
      expect(rejections).toEqual(["token_revoked"]);
      // The client body stays undifferentiated: the reason is for operators, never callers.
      expect(await res.text()).not.toContain("revoked");
    } finally {
      await handle.close();
    }
  }, 30_000);

  it("/metrics refuses a revoked scrape token", async () => {
    const fx = fixture();
    const parsed = ServerConfigSchema.parse({
      vaults: [{ id: "main", path: "/tmp/main" }],
      auth: { mode: "jwt", jwtSecret: SECRET, tokenTtlSeconds: 3600 },
    });
    const app = createMetricsApp({
      recorder: { metrics: async () => "m 1\n", contentType: "text/plain" } as never,
      bind: "0.0.0.0",
      port: 0,
      auth: parsed.auth,
      registry: fx.registry,
    });
    const token = await signAndRecord(fx.registry, claims());
    const scrape = () => app.request("/metrics", { headers: { authorization: `Bearer ${token}` } });
    expect((await scrape()).status).toBe(200);
    fx.registry.revoke(
      JSON.parse(Buffer.from(token.split(".")[1] as string, "base64url").toString()).jti,
      null,
    );
    expect((await scrape()).status).toBe(401);
  });
});

describe("revocation covers tokens this registry never issued", () => {
  it("revoking an unknown jti writes a tombstone that rejects a later token carrying it", async () => {
    const { registry } = fixture();
    const verifier = createTokenVerifier({ secret: SECRET, registry });
    // Signed by the configured secret before the registry existed: it has a jti, no row.
    const preRegistry = await new SignJWT(claims({ jti: "issued-elsewhere-1" }))
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode(SECRET));
    expect(await reasonOf(verifier.verify(preRegistry))).toBe("accepted");

    expect(registry.revoke("issued-elsewhere-1", "leaked in a paste")).toBe("tombstoned");
    expect(registry.revoke("issued-elsewhere-1", "again")).toBe("already_revoked");
    expect(await reasonOf(verifier.verify(preRegistry))).toBe("token_revoked");

    const row = registry.listTokens().find((t) => t.jti === "issued-elsewhere-1");
    expect(row).toMatchObject({
      revokedReason: "leaked in a paste",
      kid: null,
      sub: null,
      expiresAt: null,
    });
    expect(row?.revokedAt).toBeTypeOf("number");
  });

  it("a JWKS-issued token can be revoked by its jti before we ever saw it", async () => {
    const { registry } = fixture();
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "ext-1", alg: "ES256" };
    const verifier = createTokenVerifier({ jwks: { keys: [jwk] }, registry });
    const token = await new SignJWT({ ...claims(), jti: "external-42" })
      .setProtectedHeader({ alg: "ES256", kid: "ext-1" })
      .sign(privateKey);
    expect(await reasonOf(verifier.verify(token))).toBe("accepted");
    registry.revoke("external-42", null);
    expect(await reasonOf(verifier.verify(token))).toBe("token_revoked");
  });
});

describe("auth.requireJti", () => {
  const noJti = () =>
    new SignJWT(claims())
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode(SECRET));

  it("is off by default: a jti-less token still verifies", async () => {
    const { registry } = fixture();
    const verifier = createTokenVerifier({ secret: SECRET, registry });
    expect(await reasonOf(verifier.verify(await noJti()))).toBe("accepted");
  });

  it("when on, rejects a jti-less token on the HS256 and the JWKS paths, and accepts one with a jti", async () => {
    const { registry } = fixture();
    const hs = createTokenVerifier({ secret: SECRET, registry, requireJti: true });
    expect(await reasonOf(hs.verify(await noJti()))).toBe("jti_required");
    expect(await reasonOf(hs.verify(await signAndRecord(registry, claims())))).toBe("accepted");

    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "ext-1", alg: "ES256" };
    const rs = createTokenVerifier({ jwks: { keys: [jwk] }, registry, requireJti: true });
    const sign = (extra: Record<string, unknown>) =>
      new SignJWT({ ...claims(), ...extra })
        .setProtectedHeader({ alg: "ES256", kid: "ext-1" })
        .sign(privateKey);
    expect(await reasonOf(rs.verify(await sign({})))).toBe("jti_required");
    expect(await reasonOf(rs.verify(await sign({ jti: "e1" })))).toBe("accepted");
  });

  it("/metrics enforces it too", async () => {
    const fx = fixture();
    const parsed = ServerConfigSchema.parse({
      vaults: [{ id: "main", path: "/tmp/main" }],
      auth: { mode: "jwt", jwtSecret: SECRET, tokenTtlSeconds: 3600, requireJti: true },
    });
    expect(parsed.auth.requireJti).toBe(true);
    const app = createMetricsApp({
      recorder: { metrics: async () => "m 1\n", contentType: "text/plain" } as never,
      bind: "0.0.0.0",
      port: 0,
      auth: parsed.auth,
      registry: fx.registry,
    });
    const scrape = (t: string) =>
      app.request("/metrics", { headers: { authorization: `Bearer ${t}` } });
    expect((await scrape(await noJti())).status).toBe(401);
    expect((await scrape(await signAndRecord(fx.registry, claims()))).status).toBe(200);
  });

  it("defaults to false in the config schema", () => {
    const parsed = ServerConfigSchema.parse({ vaults: [{ id: "main", path: "/tmp/main" }] });
    expect(parsed.auth.requireJti).toBe(false);
  });
});

describe("/metrics binds audience and issuer like the HTTP edge", () => {
  function metricsApp(
    auth: Record<string, unknown>,
    registry: ReturnType<typeof fixture>["registry"],
  ) {
    const parsed = ServerConfigSchema.parse({
      vaults: [{ id: "main", path: "/tmp/main" }],
      auth: { mode: "jwt", jwtSecret: SECRET, tokenTtlSeconds: 3600, ...auth },
    });
    return createMetricsApp({
      recorder: { metrics: async () => "m 1\n", contentType: "text/plain" } as never,
      bind: "0.0.0.0",
      port: 0,
      auth: parsed.auth,
      registry,
    });
  }
  const scrape = (app: ReturnType<typeof createMetricsApp>, t: string) =>
    app.request("/metrics", { headers: { authorization: `Bearer ${t}` } });

  it("refuses a token minted for another audience or issuer, accepts the right one", async () => {
    const { registry } = fixture();
    const app = metricsApp({ audience: "http://test", issuer: "https://issuer.test" }, registry);
    const good = await signAndRecord(
      registry,
      claims({ aud: "http://test", iss: "https://issuer.test" }),
    );
    const wrongAud = await signAndRecord(
      registry,
      claims({ aud: "http://other", iss: "https://issuer.test" }),
    );
    const wrongIss = await signAndRecord(
      registry,
      claims({ aud: "http://test", iss: "https://evil.test" }),
    );
    const noAud = await signAndRecord(registry, claims({ iss: "https://issuer.test" }));
    expect((await scrape(app, good)).status).toBe(200);
    expect((await scrape(app, wrongAud)).status).toBe(401);
    expect((await scrape(app, wrongIss)).status).toBe(401);
    expect((await scrape(app, noAud)).status).toBe(401);
  });

  it("defaults the audience to the PRM resource, exactly as the HTTP edge does", async () => {
    const { registry } = fixture();
    const app = metricsApp(
      {
        resource: "https://mcp.example.test/mcp",
        authorizationServers: ["https://as.example.test"],
      },
      registry,
    );
    const ok = await signAndRecord(registry, claims({ aud: "https://mcp.example.test/mcp" }));
    const bad = await signAndRecord(registry, claims({ aud: "https://elsewhere.test" }));
    expect((await scrape(app, ok)).status).toBe(200);
    expect((await scrape(app, bad)).status).toBe(401);
  });
});

describe("a retiring key with no retire_after fails closed", () => {
  it("the schema refuses to store one", () => {
    const { db } = fixture();
    expect(() =>
      db
        .prepare(
          "INSERT INTO auth_keys (kid, key_ref, created_at, state, retire_after) VALUES ('k_x', 'file:k_x.key', 1, 'retiring', NULL)",
        )
        .run(),
    ).toThrow(/CHECK|constraint/i);
  });

  it("and the verifier treats a row that got past the constraint as retired", async () => {
    const { db, registry } = fixture();
    const verifier = createTokenVerifier({ secret: SECRET, registry });
    const token = await signAndRecord(registry, claims());
    registry.rotateKey({ graceSeconds: 600 }); // config -> retiring with a window
    expect(await reasonOf(verifier.verify(token))).toBe("accepted");
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.exec("UPDATE auth_keys SET retire_after = NULL WHERE state = 'retiring'");
    db.exec("PRAGMA ignore_check_constraints = OFF");
    expect(await reasonOf(verifier.verify(token))).toBe("key_retired");
  });
});
