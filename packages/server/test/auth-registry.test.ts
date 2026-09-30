// Revocation: a minted token can be killed before it expires, on every path that verifies a bearer.
// mint -> verify ok -> revoke -> verify rejected, with the token's own `exp` still in the future.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { AuthRejection } from "../src/auth/jwt";
import { authKeysDir, createAuthRegistry } from "../src/auth/registry";
import { createTokenVerifier } from "../src/auth/verifier";
import { signAndRecord } from "../src/cli/commands/token-mint";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { createMetricsApp } from "../src/metrics/endpoint";
import { startHttp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

function fixture() {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const dir = mkdtempSync(join(tmpdir(), "auth-registry-"));
  dirs.push(dir);
  const registry = createAuthRegistry(db, { configSecret: SECRET, keysDir: authKeysDir(dir) });
  return { db, dir, registry };
}

const claims = (over: Record<string, unknown> = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return { sub: "agent-1", scopes: ["read:notes"], iat: now, exp: now + 3600, ...over };
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
    expect(registry.revoke("no-such-jti", null)).toBe("unknown");
  });

  it("revocation written on one connection is seen by another process on its next request", async () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
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
      cacheDir: registryDb.dir,
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
