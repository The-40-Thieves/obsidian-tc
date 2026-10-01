// ES256 and EdDSA signing keys in the registry, alongside HS256: mint + verify round trip, the
// algorithm coming from the registry row and never from the token header alone, and the JWKS
// document carrying public material only.
import { createPublicKey } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { decodeProtectedHeader, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { AuthRejection } from "../src/auth/jwt";
import { authKeysDir, CONFIG_KID, createAuthRegistry } from "../src/auth/registry";
import { generateSigningKey } from "../src/auth/signing-keys";
import { createTokenVerifier } from "../src/auth/verifier";
import { signAndRecord } from "../src/cli/commands/token-mint";
import { provisionAuthDb, provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { startHttp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const T0 = 1_800_000_000_000;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

function fixture() {
  const db = openMemoryDb();
  provisionAuthDb(db);
  const dir = makeTempDir("auth-asym-");
  dirs.push(dir);
  const clock = { t: T0 };
  const registry = createAuthRegistry(db, {
    configSecret: SECRET,
    keysDir: authKeysDir(dir),
    now: () => clock.t,
  });
  return {
    db,
    dir,
    clock,
    registry,
    verifier: createTokenVerifier({ secret: SECRET, registry }),
  };
}
type Fixture = ReturnType<typeof fixture>;

const claims = () => {
  const now = Math.floor(Date.now() / 1000);
  return { sub: "agent-1", scopes: ["read:notes"], iat: now, exp: now + 3600 };
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

async function rotateTo(f: Fixture, alg: "ES256" | "EdDSA", graceSeconds = 0) {
  const generated = await generateSigningKey(alg);
  return f.registry.rotateKey({ alg, generated, graceSeconds });
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const hmacToken = (header: Record<string, unknown>, key: Uint8Array | string) =>
  new SignJWT(claims())
    .setProtectedHeader({ alg: "HS256", ...header })
    .sign(typeof key === "string" ? new TextEncoder().encode(key) : key);

describe.each(["ES256", "EdDSA"] as const)("%s registry key", (alg) => {
  it("mints and verifies a round trip, with the algorithm and kid in the header", async () => {
    const f = fixture();
    const r = await rotateTo(f, alg);
    const token = await signAndRecord(f.registry, claims());
    expect(decodeProtectedHeader(token)).toMatchObject({ alg, kid: r.kid, typ: "JWT" });
    const id = await f.verifier.verify(token);
    expect(id.caller).toBe("agent-1");
    expect(id.scopes).toEqual(new Set(["read:notes"]));
  });

  it("keeps the private key in a 0600 file and only public material in auth.db", async () => {
    const f = fixture();
    const r = await rotateTo(f, alg);
    const keysDir = authKeysDir(f.dir);
    const file = join(keysDir, `${r.kid}.key`);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const priv = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    expect(priv.d).toBeTypeOf("string");

    const row = f.db.prepare("SELECT * FROM auth_keys WHERE kid = ?").get(r.kid) as Record<
      string,
      unknown
    >;
    expect(row.alg).toBe(alg);
    expect(row.key_ref).toBe(`file:${r.kid}.key`);
    const pub = JSON.parse(row.public_jwk as string) as Record<string, string>;
    expect(pub.d).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain(priv.d as string);
    expect(readdirSync(keysDir)).toContain(`${r.kid}.key`);
  });

  it("verifies inside the grace window and refuses outside it, reaper or not", async () => {
    const f = fixture();
    await rotateTo(f, alg, 0);
    const old = await signAndRecord(f.registry, claims());
    await rotateTo(f, alg, 60);
    f.clock.t = T0 + 30_000;
    expect(await reasonOf(f.verifier.verify(old))).toBe("accepted");
    f.clock.t = T0 + 61_000;
    expect(await reasonOf(f.verifier.verify(old))).toBe("key_retired");
  });

  it("refuses a token signed by a different key that claims this kid (bad_signature)", async () => {
    const f = fixture();
    const r = await rotateTo(f, alg);
    const attacker = await generateKeyPair(alg);
    const forged = await new SignJWT(claims())
      .setProtectedHeader({ alg, kid: r.kid })
      .sign(attacker.privateKey);
    expect(await reasonOf(f.verifier.verify(forged))).toBe("bad_signature");
  });
});

describe("alg confusion is rejected: the registry row picks the algorithm, not the header", () => {
  it("HS256 token whose HMAC key is the public key (JWK JSON, PEM and raw coordinates)", async () => {
    for (const alg of ["ES256", "EdDSA"] as const) {
      const f = fixture();
      const r = await rotateTo(f, alg);
      const row = f.db.prepare("SELECT public_jwk FROM auth_keys WHERE kid = ?").get(r.kid) as {
        public_jwk: string;
      };
      const jwk = JSON.parse(row.public_jwk) as Record<string, string>;
      const pem = createPublicKey({ key: jwk as never, format: "jwk" }).export({
        type: "spki",
        format: "pem",
      }) as string;
      const candidates: (Uint8Array | string)[] = [
        row.public_jwk,
        pem,
        Buffer.from(jwk.x as string, "base64url"),
        Buffer.from(`${jwk.x}${jwk.y ?? ""}`),
      ];
      for (const key of candidates) {
        const token = await hmacToken({ kid: r.kid }, key);
        expect(await reasonOf(f.verifier.verify(token))).toBe("unsupported_alg");
      }
    }
  });

  it("HS256 header naming an asymmetric kid, signed with the PRIVATE key material as the secret", async () => {
    const f = fixture();
    const r = await rotateTo(f, "ES256");
    const priv = readFileSync(join(authKeysDir(f.dir), `${r.kid}.key`), "utf8");
    const token = await hmacToken({ kid: r.kid }, priv);
    expect(await reasonOf(f.verifier.verify(token))).toBe("unsupported_alg");
  });

  it("the registry never hands asymmetric key bytes to the HMAC path", async () => {
    const f = fixture();
    const r = await rotateTo(f, "EdDSA");
    expect(() => f.registry.verificationKey(r.kid)).toThrow(AuthRejection);
    try {
      f.registry.verificationKey(r.kid);
    } catch (e) {
      expect((e as AuthRejection).reason).toBe("unsupported_alg");
    }
  });

  it("asymmetric header naming an HS256 registry kid is refused, even signed by any key", async () => {
    const f = fixture();
    f.registry.rotateKey({ graceSeconds: 600 }); // config key is now retiring; new HS256 key active
    const hsActive = f.registry.listKeys().find((k) => k.state === "active")?.kid as string;
    for (const alg of ["ES256", "EdDSA"] as const) {
      const attacker = await generateKeyPair(alg);
      for (const kid of [hsActive, CONFIG_KID]) {
        const forged = await new SignJWT(claims())
          .setProtectedHeader({ alg, kid })
          .sign(attacker.privateKey);
        expect(await reasonOf(f.verifier.verify(forged))).toBe("unsupported_alg");
      }
    }
  });

  it("an EdDSA header against an ES256 row (and the reverse) is refused as an alg mismatch", async () => {
    const f = fixture();
    const es = await rotateTo(f, "ES256", 600);
    const ed = await rotateTo(f, "EdDSA", 600);
    const attackerEd = await generateKeyPair("EdDSA");
    const attackerEs = await generateKeyPair("ES256");
    const a = await new SignJWT(claims())
      .setProtectedHeader({ alg: "EdDSA", kid: es.kid })
      .sign(attackerEd.privateKey);
    const b = await new SignJWT(claims())
      .setProtectedHeader({ alg: "ES256", kid: ed.kid })
      .sign(attackerEs.privateKey);
    expect(await reasonOf(f.verifier.verify(a))).toBe("unsupported_alg");
    expect(await reasonOf(f.verifier.verify(b))).toBe("unsupported_alg");
  });

  it("alg `none` is refused, with or without a registry kid", async () => {
    const f = fixture();
    const r = await rotateTo(f, "ES256");
    const payload = claims();
    for (const kid of [r.kid, CONFIG_KID, undefined]) {
      const unsigned = `${b64({ alg: "none", ...(kid ? { kid } : {}) })}.${b64(payload)}.`;
      await expect(f.verifier.verify(unsigned)).rejects.toThrow();
      expect(
        await f.verifier.verify(unsigned).then(
          () => "accepted",
          () => "refused",
        ),
      ).toBe("refused");
    }
  });

  it("an asymmetric token with no kid never resolves against the registry", async () => {
    const f = fixture();
    await rotateTo(f, "EdDSA");
    const token = await signAndRecord(f.registry, claims());
    const kidless = `${b64({ alg: "EdDSA", typ: "JWT" })}.${token.split(".")[1]}.${token.split(".")[2]}`;
    expect(
      await f.verifier.verify(kidless).then(
        () => "accepted",
        () => "refused",
      ),
    ).toBe("refused");
  });

  it("auth.algorithms narrows the registry algorithms too", async () => {
    const f = fixture();
    await rotateTo(f, "ES256");
    const token = await signAndRecord(f.registry, claims());
    const narrowed = createTokenVerifier({
      secret: SECRET,
      registry: f.registry,
      algorithms: ["EdDSA"],
    });
    expect(await reasonOf(narrowed.verify(token))).toBe("unsupported_alg");
    expect(await reasonOf(f.verifier.verify(token))).toBe("accepted");
  });

  it("revocation applies to registry-issued asymmetric tokens", async () => {
    const f = fixture();
    await rotateTo(f, "ES256");
    const token = await signAndRecord(f.registry, claims());
    // includeExpired: the fixture clock (2027) is past the token's real-clock exp.
    const jti = f.registry.listTokens({ includeExpired: true })[0]?.jti as string;
    f.registry.revoke(jti, "test");
    expect(await reasonOf(f.verifier.verify(token))).toBe("token_revoked");
  });
});

describe("JWKS document", () => {
  it("has active and in-window retiring asymmetric keys, public members only", async () => {
    const f = fixture();
    const first = await rotateTo(f, "ES256", 0);
    const second = await rotateTo(f, "EdDSA", 0); // first retired at once
    const third = await rotateTo(f, "ES256", 600); // second retiring for 10 minutes, third active
    const doc = f.registry.publicJwks();
    expect(doc.keys.map((k) => k.kid).sort()).toEqual([second.kid, third.kid].sort());
    expect(doc.keys.map((k) => k.kid)).not.toContain(first.kid);
    const text = JSON.stringify(doc);
    for (const k of doc.keys) {
      expect(
        Object.keys(k).every((m) => ["kty", "crv", "x", "y", "kid", "alg", "use"].includes(m)),
      ).toBe(true);
      expect(k.use).toBe("sig");
      const priv = JSON.parse(
        readFileSync(join(authKeysDir(f.dir), `${k.kid}.key`), "utf8"),
      ) as Record<string, string>;
      expect(text).not.toContain(priv.d as string);
    }
    // The HS256 config key is never published.
    expect(doc.keys.some((k) => k.kty === "oct")).toBe(false);
    expect(text).not.toContain(SECRET);
  });

  it("drops a retiring key the moment its window elapses, before any reaper runs", async () => {
    const f = fixture();
    await rotateTo(f, "ES256", 0);
    const retiring = await rotateTo(f, "EdDSA", 60);
    void retiring;
    const ed = f.registry.listKeys().find((k) => k.alg === "EdDSA")?.kid;
    await rotateTo(f, "ES256", 60);
    expect(f.registry.publicJwks().keys.map((k) => k.kid)).toContain(ed);
    f.clock.t = T0 + 61_000;
    expect(f.registry.publicJwks().keys.map((k) => k.kid)).not.toContain(ed);
  });

  it("verifies a registry-signed token with an independent verifier from the published JWKS", async () => {
    const f = fixture();
    await rotateTo(f, "EdDSA");
    const token = await signAndRecord(f.registry, claims());
    const external = createTokenVerifier({ jwks: f.registry.publicJwks() });
    expect((await external.verify(token)).caller).toBe("agent-1");
  });

  it("is served, unauthenticated, at /.well-known/jwks.json", async () => {
    const f = fixture();
    await rotateTo(f, "ES256");
    const cacheDb = openMemoryDb();
    provisionCacheDb(cacheDb);
    const handle = await startHttp({
      name: "obsidian-tc",
      version: "t",
      registry: new ToolRegistry(),
      auth: { mode: "jwt", jwtSecret: SECRET, tokenTtlSeconds: 86400, requireJti: false } as never,
      db: cacheDb,
      authRegistry: f.registry,
      vaultId: "v1",
      acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/.well-known/jwks.json`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      const doc = (await res.json()) as { keys: Record<string, string>[] };
      expect(doc.keys).toHaveLength(1);
      expect(doc.keys[0]?.d).toBeUndefined();
      expect(doc.keys[0]?.alg).toBe("ES256");
    } finally {
      await handle.close();
    }
  });

  it("exportJWK of a generated public key is what is stored (sanity for the fixture)", async () => {
    const { publicKey } = await generateKeyPair("ES256");
    expect((await exportJWK(publicKey)).kty).toBe("EC");
  });
});
