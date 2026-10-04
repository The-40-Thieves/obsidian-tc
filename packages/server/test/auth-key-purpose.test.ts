// Registry key PURPOSE (authorization-server design v2, section 4.2, slice S2): every signing key
// is `mint` (the operator's hand-minted tokens: HS256 or asymmetric, today's behaviour) or `as`
// (the bundled authorization server's access tokens: ES256/EdDSA only). One ACTIVE key per purpose,
// so rotating one never retires the other, and the verifier applies rules chosen by the purpose of
// the row a token's `kid` names. Nothing issues `as` tokens yet: these tests sign them directly.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SignJWT } from "jose";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRejection } from "../src/auth/jwt";
import { authKeysDir, createAuthRegistry, registryMarkerPath } from "../src/auth/registry";
import { openAuthRegistry } from "../src/auth/registry-open";
import { generateSigningKey, importSigningKey } from "../src/auth/signing-keys";
import { createTokenVerifier } from "../src/auth/verifier";
import { parseCliArgs } from "../src/cli/args";
import { run_auth } from "../src/cli/commands/auth";
import { signAndRecord } from "../src/cli/commands/token-mint";
import { runMigrations } from "../src/db/migrate";
import { AUTH_MIGRATIONS, provisionAuthDb } from "../src/db/provision";
import { registryKeyResolver } from "../src/provenance/signer";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const T0 = 1_800_000_000_000;
const AS_ISS = "https://vault.example.com";
const LEGACY_ISS = "https://legacy-issuer.example";
const RESOURCE = "https://vault.example.com/mcp";
// accessTokenSeconds (default 1800) + 60 s clock skew.
const AS_FLOOR = 1860;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

function fixture(verifierOpts: Record<string, unknown> = {}) {
  const db = openMemoryDb();
  provisionAuthDb(db);
  const dir = makeTempDir("auth-purpose-");
  dirs.push(dir);
  const clock = { t: T0 };
  const registry = createAuthRegistry(db, {
    configSecret: SECRET,
    keysDir: authKeysDir(dir),
    now: () => clock.t,
  });
  const verifier = createTokenVerifier({
    secret: SECRET,
    registry,
    asIssuer: AS_ISS,
    resource: RESOURCE,
    audience: RESOURCE,
    ...verifierOpts,
  } as never);
  return { db, dir, clock, registry, verifier };
}
type Fixture = ReturnType<typeof fixture>;

const rotate = async (
  f: Fixture,
  purpose: "mint" | "as",
  alg: "ES256" | "EdDSA" = "ES256",
  graceSeconds = 0,
) =>
  f.registry.rotateKey({
    purpose,
    alg,
    generated: await generateSigningKey(alg),
    graceSeconds,
  } as never);

const nowSec = () => Math.floor(Date.now() / 1000);

/** An access token signed with the ACTIVE `as` key. `undefined` removes a claim. */
async function asToken(
  f: Fixture,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
): Promise<string> {
  const { kid, alg, secret } = f.registry.signingKey({ purpose: "as" } as never);
  const body = {
    iss: AS_ISS,
    sub: "user-1",
    aud: RESOURCE,
    client_id: "client-1",
    scope: "read:notes",
    iat: nowSec(),
    exp: nowSec() + 600,
    jti: randomUUID(),
    ...claims,
  };
  return new SignJWT(body)
    .setProtectedHeader({ alg, kid, typ: "at+jwt", ...header })
    .sign(await importSigningKey(alg as "ES256" | "EdDSA", secret));
}

async function reasonOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AuthRejection) return e.reason;
    throw e;
  }
  return "accepted";
}

const purposesOf = (f: Fixture) =>
  Object.fromEntries(
    (f.registry.listKeys() as { kid: string; purpose?: string; state: string }[]).map((k) => [
      k.kid,
      `${k.purpose}:${k.state}`,
    ]),
  );

describe("auth.db migration: purpose column and per-purpose active index", () => {
  it("upgrades a pre-purpose registry: every existing row becomes `mint`", () => {
    const db = openMemoryDb();
    // The chain as it shipped before this slice.
    runMigrations(db, AUTH_MIGRATIONS.slice(0, 3));
    db.prepare(
      "INSERT INTO auth_keys (kid, alg, key_ref, created_at, state) VALUES ('config', 'HS256', 'config', 1, 'active')",
    ).run();
    provisionAuthDb(db);
    const row = db.prepare("SELECT purpose FROM auth_keys WHERE kid = 'config'").get() as {
      purpose: string;
    };
    expect(row.purpose).toBe("mint");
  });

  it("allows one active key per purpose and refuses a second in the same purpose", () => {
    const db = openMemoryDb();
    provisionAuthDb(db);
    const ins = (kid: string, purpose: string) =>
      db
        .prepare(
          "INSERT INTO auth_keys (kid, alg, key_ref, created_at, state, purpose) VALUES (?, 'ES256', 'x', 1, 'active', ?)",
        )
        .run(kid, purpose);
    ins("m1", "mint");
    ins("a1", "as");
    expect(() => ins("m2", "mint")).toThrow(/UNIQUE/i);
    expect(() => ins("a2", "as")).toThrow(/UNIQUE/i);
  });

  it("refuses a purpose outside mint/as", () => {
    const db = openMemoryDb();
    provisionAuthDb(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO auth_keys (kid, alg, key_ref, created_at, state, purpose) VALUES ('z', 'ES256', 'x', 1, 'retired', 'other')",
        )
        .run(),
    ).toThrow(/CHECK/i);
  });
});

describe("section 7 step 1: hand-minted HS256 tokens survive the AS key", () => {
  it("a config-secret HS256 token still verifies after the `as` key is created and rotated twice", async () => {
    const f = fixture();
    const hs = await signAndRecord(f.registry, {
      sub: "agent-1",
      scopes: ["read:notes"],
      aud: RESOURCE,
      iat: nowSec(),
      exp: nowSec() + 600,
    });
    await rotate(f, "as");
    await rotate(f, "as", "ES256", AS_FLOOR);
    await rotate(f, "as", "ES256", AS_FLOOR);
    expect(await reasonOf(f.verifier.verify(hs))).toBe("accepted");
  });

  it("a registry-rotated HS256 mint key keeps signing and verifying across `as` rotations", async () => {
    const f = fixture();
    const mintKey = f.registry.rotateKey({ graceSeconds: 0 });
    await rotate(f, "as");
    await rotate(f, "as", "ES256", AS_FLOOR);
    expect(f.registry.signingKey().kid).toBe(mintKey.kid);
    const hs = await signAndRecord(f.registry, {
      sub: "agent-1",
      scopes: ["read:notes"],
      aud: RESOURCE,
      iat: nowSec(),
      exp: nowSec() + 600,
    });
    expect(await reasonOf(f.verifier.verify(hs))).toBe("accepted");
  });

  it("the mint flow is byte-identical with and without an `as` key present", async () => {
    const f = fixture();
    const claims = {
      sub: "agent-1",
      scopes: ["read:notes"],
      iat: 1_900_000_000,
      exp: 1_900_003_600,
    };
    const mintBytes = async () => {
      const k = f.registry.signingKey();
      return new SignJWT({ ...claims, jti: "fixed-jti" })
        .setProtectedHeader({ alg: k.alg, typ: "JWT", kid: k.kid })
        .sign(new TextEncoder().encode(k.secret));
    };
    const before = await mintBytes();
    await rotate(f, "as");
    expect(await mintBytes()).toBe(before);
    expect(f.registry.signingKey().kid).toBe("config");
  });

  it("config-secret HS256 tokens verify when the only registry rows are `as` keys (legacy reading kept)", async () => {
    const f = fixture();
    await rotate(f, "as");
    const hs = await new SignJWT({ sub: "a", exp: nowSec() + 600, aud: RESOURCE })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .sign(new TextEncoder().encode(SECRET));
    expect(await reasonOf(f.verifier.verify(hs))).toBe("accepted");
  });

  it("`auth.issuer` keeps binding mint-purpose tokens only", async () => {
    const f = fixture({ issuer: LEGACY_ISS });
    const hs = await new SignJWT({ sub: "a", exp: nowSec() + 600, aud: RESOURCE, iss: LEGACY_ISS })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .sign(new TextEncoder().encode(SECRET));
    await rotate(f, "as");
    expect(await reasonOf(f.verifier.verify(hs))).toBe("accepted");
    // The as-issued token carries the AS issuer, which is not the legacy one: it still verifies.
    expect(await reasonOf(f.verifier.verify(await asToken(f)))).toBe("accepted");
  });
});

describe("`as` keys rotate independently of `mint` keys", () => {
  it("holds one active key per purpose; rotating one leaves the other active", async () => {
    const f = fixture();
    const mint1 = await rotate(f, "mint", "EdDSA");
    const as1 = await rotate(f, "as");
    expect(purposesOf(f)).toMatchObject({ [mint1.kid]: "mint:active", [as1.kid]: "as:active" });

    const as2 = await rotate(f, "as", "ES256", AS_FLOOR);
    expect(as2.previousKid).toBe(as1.kid);
    expect(purposesOf(f)).toMatchObject({
      [mint1.kid]: "mint:active",
      [as1.kid]: "as:retiring",
      [as2.kid]: "as:active",
    });

    const mint2 = await rotate(f, "mint", "EdDSA");
    expect(mint2.previousKid).toBe(mint1.kid);
    expect(purposesOf(f)[as2.kid]).toBe("as:active");
  });

  it("a mint rotation never retires the `as` key, and `signingKey` is per purpose", async () => {
    const f = fixture();
    const as1 = await rotate(f, "as");
    const mint = await rotate(f, "mint", "EdDSA");
    expect(f.registry.signingKey().kid).toBe(mint.kid);
    expect((f.registry.signingKey({ purpose: "as" } as never) as { kid: string }).kid).toBe(
      as1.kid,
    );
  });

  it("the previous `as` key keeps verifying during the grace window, then is retired", async () => {
    const f = fixture();
    await rotate(f, "as");
    const old = await asToken(f);
    await rotate(f, "as", "ES256", AS_FLOOR);
    expect(await reasonOf(f.verifier.verify(old))).toBe("accepted");
    f.clock.t += (AS_FLOOR + 1) * 1000;
    expect(await reasonOf(f.verifier.verify(old))).toBe("key_retired");
  });

  it("refuses an HS256 `as` key", async () => {
    const f = fixture();
    expect(() => f.registry.rotateKey({ purpose: "as", alg: "HS256" } as never)).toThrow(/as/);
    expect(f.registry.listKeys()).toEqual([]);
  });

  it("refuses an unknown purpose", async () => {
    const f = fixture();
    expect(() => f.registry.rotateKey({ purpose: "bogus" } as never)).toThrow(/purpose/);
  });

  it("enforces a grace floor of accessTokenSeconds + 60 s when an `as` key is replaced", async () => {
    const f = fixture();
    await rotate(f, "as"); // no previous key: nothing to protect
    await expect(rotate(f, "as", "ES256", 0)).rejects.toThrow(/grace/);
    await expect(rotate(f, "as", "ES256", AS_FLOOR - 1)).rejects.toThrow(/grace/);
    expect((await rotate(f, "as", "ES256", AS_FLOOR)).previousKid).not.toBeNull();
    // A shorter access-token lifetime lowers the floor with it.
    const g = await generateSigningKey("ES256");
    expect(() =>
      f.registry.rotateKey({
        purpose: "as",
        alg: "ES256",
        generated: g,
        graceSeconds: 360,
        accessTokenSeconds: 300,
      } as never),
    ).not.toThrow();
    // A refused rotation leaves no key file behind and the active key unchanged.
    const before = purposesOf(f);
    await expect(rotate(f, "as", "ES256", 10)).rejects.toThrow(/grace/);
    expect(purposesOf(f)).toEqual(before);
    expect(readdirSync(authKeysDir(f.dir)).filter((n) => n.endsWith(".key"))).toHaveLength(
      Object.keys(before).length,
    );
  });

  it("a mint rotation keeps today's grace rules (no floor)", async () => {
    const f = fixture();
    await rotate(f, "mint");
    expect((await rotate(f, "mint", "ES256", 0)).previousKid).not.toBeNull();
  });

  it("stores the `as` private key in a 0600 file, never in auth.db, with the RFC 7638 thumbprint as kid", async () => {
    const f = fixture();
    const r = await rotate(f, "as");
    const names = readdirSync(authKeysDir(f.dir)).filter((n) => n.endsWith(".key"));
    expect(names).toHaveLength(1);
    expect(r.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const dump = JSON.stringify(f.db.prepare("SELECT * FROM auth_keys").all());
    expect(dump).not.toContain('"d"');
    expect(dump).not.toMatch(/"d\\?":/);
  });
});

describe("JWKS publishes the asymmetric keys of both purposes", () => {
  it("lists the active mint and `as` keys, plus an in-window retiring `as` key", async () => {
    const f = fixture();
    const mint = await rotate(f, "mint", "EdDSA");
    const as1 = await rotate(f, "as");
    const as2 = await rotate(f, "as", "ES256", AS_FLOOR);
    const kids = f.registry.publishedJwks().jwks.keys.map((k) => k.kid);
    expect(kids.sort()).toEqual([mint.kid, as1.kid, as2.kid].sort());
    for (const k of f.registry.publishedJwks().jwks.keys) expect(k).not.toHaveProperty("d");
  });
});

describe("verifier: per-purpose rules for an `as` key", () => {
  it("accepts a well-formed RFC 9068 access token and reports the key purpose and client", async () => {
    const f = fixture();
    await rotate(f, "as");
    const id = (await f.verifier.verify(await asToken(f))) as {
      caller: string;
      scopes: Set<string>;
      keyPurpose?: string;
      clientId?: string;
    };
    expect(id.caller).toBe("user-1");
    expect([...id.scopes]).toEqual(["read:notes"]);
    expect(id.keyPurpose).toBe("as");
    expect(id.clientId).toBe("client-1");
  });

  it("refuses an `as`-signed token whose iss is the legacy auth.issuer (key-purpose confusion)", async () => {
    const f = fixture({ issuer: LEGACY_ISS });
    await rotate(f, "as");
    expect(await reasonOf(f.verifier.verify(await asToken(f, { iss: LEGACY_ISS })))).toBe(
      "issuer_mismatch",
    );
    expect(await reasonOf(f.verifier.verify(await asToken(f, { iss: undefined })))).toBe(
      "missing_claim",
    );
  });

  it("refuses typ other than at+jwt", async () => {
    const f = fixture();
    await rotate(f, "as");
    expect(await reasonOf(f.verifier.verify(await asToken(f, {}, { typ: "JWT" })))).toBe(
      "invalid_token_type",
    );
    expect(await reasonOf(f.verifier.verify(await asToken(f, {}, { typ: undefined })))).toBe(
      "invalid_token_type",
    );
  });

  it("accepts the media-type form of typ (application/at+jwt, RFC 8725 section 3.11), nothing else", async () => {
    // Cross-slice contract: the issuing path (S5) sets `typ: "at+jwt"` on every access token it signs.
    const f = fixture();
    await rotate(f, "as");
    expect(
      await reasonOf(f.verifier.verify(await asToken(f, {}, { typ: "application/at+jwt" }))),
    ).toBe("accepted");
    for (const typ of ["id_token+jwt", "application/jwt", "at+jwt+x", "JWT"]) {
      expect(await reasonOf(f.verifier.verify(await asToken(f, {}, { typ })))).toBe(
        "invalid_token_type",
      );
    }
  });

  it("refuses a token with no client_id or an empty one", async () => {
    const f = fixture();
    await rotate(f, "as");
    expect(await reasonOf(f.verifier.verify(await asToken(f, { client_id: undefined })))).toBe(
      "missing_claim",
    );
    expect(await reasonOf(f.verifier.verify(await asToken(f, { client_id: "" })))).toBe(
      "missing_claim",
    );
  });

  it("refuses another audience, a missing one, and an audience list", async () => {
    const f = fixture({ audience: undefined });
    await rotate(f, "as");
    expect(
      await reasonOf(f.verifier.verify(await asToken(f, { aud: "https://other.example/mcp" }))),
    ).toBe("audience_mismatch");
    expect(await reasonOf(f.verifier.verify(await asToken(f, { aud: undefined })))).toBe(
      "missing_claim",
    );
    expect(await reasonOf(f.verifier.verify(await asToken(f, { aud: [RESOURCE, "x"] })))).toBe(
      "audience_mismatch",
    );
  });

  it("holds the audience to auth.resource even when auth.audience names another value", async () => {
    const f = fixture({ audience: "https://custom-audience.example" });
    await rotate(f, "as");
    expect(await reasonOf(f.verifier.verify(await asToken(f)))).toBe("accepted");
    expect(
      await reasonOf(
        f.verifier.verify(await asToken(f, { aud: "https://custom-audience.example" })),
      ),
    ).toBe("audience_mismatch");
  });

  it("refuses a token with no jti, even when auth.requireJti is off", async () => {
    const f = fixture({ requireJti: false });
    await rotate(f, "as");
    expect(await reasonOf(f.verifier.verify(await asToken(f, { jti: undefined })))).toBe(
      "missing_claim",
    );
  });

  it("refuses every `as` token when the verifier was given no AS issuer or no resource", async () => {
    for (const missing of ["asIssuer", "resource"]) {
      const f = fixture({ [missing]: undefined });
      await rotate(f, "as");
      expect(await reasonOf(f.verifier.verify(await asToken(f)))).toBe("misconfigured");
    }
  });

  it("honours jti revocation for an `as` token", async () => {
    const f = fixture();
    await rotate(f, "as");
    const jti = randomUUID();
    f.registry.revoke(jti, "test");
    expect(await reasonOf(f.verifier.verify(await asToken(f, { jti })))).toBe("token_revoked");
  });

  it("reads scopes from `scope` only: a stray `scopes` array on an `as` token grants nothing", async () => {
    const f = fixture();
    await rotate(f, "as");
    const id = await f.verifier.verify(await asToken(f, { scopes: ["*"], scope: "read:notes" }));
    expect([...id.scopes]).toEqual(["read:notes"]);
  });

  it("refuses an HS256 header that names an `as` kid", async () => {
    const f = fixture();
    const as1 = await rotate(f, "as");
    const forged = await new SignJWT({ sub: "x", exp: nowSec() + 600, aud: RESOURCE })
      .setProtectedHeader({ alg: "HS256", kid: as1.kid, typ: "at+jwt" })
      .sign(new TextEncoder().encode(SECRET));
    expect(await reasonOf(f.verifier.verify(forged))).toBe("unsupported_alg");
  });

  it("refuses a token signed by an `as` key but shaped like a hand-minted one", async () => {
    // What a leaked `as` key would be used for: a token with the legacy shape (typ JWT, no
    // client_id, no jti, scopes array, the legacy issuer) must not ride the generic path.
    const f = fixture({ issuer: LEGACY_ISS });
    await rotate(f, "as");
    const { kid, alg, secret } = f.registry.signingKey({ purpose: "as" } as never);
    const minted = new SignJWT({
      sub: "agent-1",
      scopes: ["*"],
      aud: RESOURCE,
      iss: LEGACY_ISS,
      iat: nowSec(),
      exp: nowSec() + 600,
    })
      .setProtectedHeader({ alg, kid, typ: "JWT" })
      .sign(await importSigningKey(alg as "ES256", secret));
    expect(await reasonOf(f.verifier.verify(await minted))).not.toBe("accepted");
    // No issuer configured at all: the AS issuer is still demanded.
    const g = fixture();
    await rotate(g, "as");
    const k = g.registry.signingKey({ purpose: "as" } as never);
    const bare = new SignJWT({ sub: "a", scopes: ["*"], aud: RESOURCE, exp: nowSec() + 600 })
      .setProtectedHeader({ alg: k.alg, kid: k.kid })
      .sign(await importSigningKey(k.alg as "ES256", k.secret));
    expect(await reasonOf(g.verifier.verify(await bare))).not.toBe("accepted");
  });

  it("a mint-key token wearing the AS shape never gains `as` treatment", async () => {
    // Legacy issuer configured: the AS issuer string is not it, so the mint rules refuse the token.
    const f = fixture({ issuer: LEGACY_ISS });
    await rotate(f, "mint", "ES256");
    const mk = f.registry.signingKey();
    const shaped = (iss: string) =>
      importSigningKey(mk.alg as "ES256", mk.secret).then((key) =>
        new SignJWT({
          iss,
          sub: "u",
          aud: RESOURCE,
          client_id: "c",
          scope: "admin:auth",
          iat: nowSec(),
          exp: nowSec() + 600,
          jti: randomUUID(),
        })
          .setProtectedHeader({ alg: mk.alg, kid: mk.kid, typ: "at+jwt" })
          .sign(key),
      );
    expect(await reasonOf(f.verifier.verify(await shaped(AS_ISS)))).toBe("issuer_mismatch");
    // Operator-signed with the legacy issuer, it is a hand-minted token and is treated as one.
    const id = await f.verifier.verify(await shaped(LEGACY_ISS));
    expect(id.keyPurpose).toBeUndefined();
    expect(id.clientId).toBeUndefined();
  });

  it("refuses a registry key whose purpose this code does not know", async () => {
    const f = fixture();
    const as1 = await rotate(f, "as");
    const real = f.registry;
    const odd = {
      ...real,
      verificationMaterial: (kid: string | undefined) => ({
        ...real.verificationMaterial(kid),
        purpose: "future",
      }),
    };
    const verifier = createTokenVerifier({
      registry: odd as never,
      asIssuer: AS_ISS,
      resource: RESOURCE,
      audience: RESOURCE,
    } as never);
    expect(as1.kid).toBeDefined();
    expect(await reasonOf(verifier.verify(await asToken(f)))).toBe("misconfigured");
  });

  it("a mint-purpose asymmetric key keeps today's rules: no typ, client_id or jti demanded", async () => {
    const f = fixture({ issuer: LEGACY_ISS });
    await rotate(f, "mint", "ES256");
    const token = await signAndRecord(f.registry, {
      sub: "agent-1",
      scopes: ["read:notes"],
      aud: RESOURCE,
      iss: LEGACY_ISS,
      iat: nowSec(),
      exp: nowSec() + 600,
    });
    const id = await f.verifier.verify(token);
    expect((id as { keyPurpose?: string }).keyPurpose).toBeUndefined();
  });
});

describe("fail-closed: losing one purpose's keys is a lost registry", () => {
  it("refuses everything once `as` rows are gone but their marker remains", async () => {
    const f = fixture();
    await rotate(f, "as");
    const token = await asToken(f);
    f.db.prepare("DELETE FROM auth_keys WHERE purpose = 'as'").run();
    expect(await reasonOf(f.verifier.verify(token))).toBe("registry_lost");
    expect(f.registry.health().state).toBe("lost");
  });

  it("does not revive the configured secret when mint rows vanish but `as` rows survive", async () => {
    const f = fixture();
    f.registry.rotateKey({ graceSeconds: 0 }); // enrols `config`, then a file key: mint marker armed
    await rotate(f, "as");
    f.db.prepare("DELETE FROM auth_keys WHERE purpose = 'mint'").run();
    const hs = await new SignJWT({ sub: "a", exp: nowSec() + 600, aud: RESOURCE })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .sign(new TextEncoder().encode(SECRET));
    expect(await reasonOf(f.verifier.verify(hs))).toBe("registry_lost");
  });

  it("a missing auth.db with only `as` key files on disk opens as a lost registry, not a fresh one", async () => {
    const dir = makeTempDir("auth-purpose-lost-");
    dirs.push(dir);
    const first = await openAuthRegistry({
      cacheDir: dir,
      db: {},
      auth: { jwtSecret: SECRET },
    } as never);
    first.registry.rotateKey({
      purpose: "as",
      alg: "ES256",
      generated: await generateSigningKey("ES256"),
    } as never);
    first.close();
    expect(existsSync(registryMarkerPath(authKeysDir(dir), "keys"))).toBe(false);
    for (const f of readdirSync(dir)) {
      if (f.startsWith("auth.db")) rmSync(join(dir, f)); // the database only; auth-keys/ stays
    }
    const second = await openAuthRegistry({
      cacheDir: dir,
      db: {},
      auth: { jwtSecret: SECRET },
    } as never);
    expect(second.registry.health().state).toBe("lost");
  });
});

describe("provenance key resolution ignores `as` keys", () => {
  it("never resolves an `as` EdDSA key as a provenance key", async () => {
    const f = fixture();
    const as1 = await rotate(f, "as", "EdDSA");
    const mint = await rotate(f, "mint", "EdDSA");
    const resolve = registryKeyResolver(f.registry.listKeys());
    expect(resolve(as1.kid)).toBeUndefined();
    expect(resolve(mint.kid)).toBeDefined();
  });
});

describe("reaper: expired auth_tokens rows", () => {
  const rec = (f: Fixture, jti: string, expiresAt: number | null, issuedAt = T0) =>
    f.registry.recordToken({
      jti,
      kid: "config",
      sub: "s",
      scopesSummary: "",
      issuedAt,
      expiresAt,
    });
  const DAY = 86_400_000;

  it("drops rows more than a day past exp, keeps live ones, recent ones and tombstones", () => {
    const f = fixture();
    rec(f, "old", T0 - 2 * DAY);
    rec(f, "just-expired", T0 - DAY / 2);
    rec(f, "live", T0 + DAY);
    f.registry.revoke("never-issued-here", "t");
    const reaped = (f.registry as unknown as { reapExpiredTokens(): number }).reapExpiredTokens();
    expect(reaped).toBe(1);
    const left = f.registry
      .listTokens({ includeExpired: true })
      .map((t) => t.jti)
      .sort();
    expect(left).toEqual(["just-expired", "live", "never-issued-here"]);
  });

  it("never empties the table: an empty auth_tokens beside its marker reads as a lost registry", () => {
    const f = fixture();
    rec(f, "a", T0 - 5 * DAY);
    rec(f, "b", T0 - 4 * DAY);
    (f.registry as unknown as { reapExpiredTokens(): number }).reapExpiredTokens();
    expect(f.registry.listTokens({ includeExpired: true })).toHaveLength(1);
    expect(f.registry.health().state).toBe("ok");
    expect(f.registry.isRevoked("a")).toBe(false);
  });

  it("is run when the registry is opened for serving", async () => {
    const dir = makeTempDir("auth-purpose-reap-");
    dirs.push(dir);
    const clock = { t: Date.now() };
    const cfg = { cacheDir: dir, db: {}, auth: { jwtSecret: SECRET } } as never;
    const first = await openAuthRegistry(cfg, { now: () => clock.t });
    const mk = (jti: string, exp: number) =>
      first.registry.recordToken({
        jti,
        kid: "config",
        sub: "s",
        scopesSummary: "",
        issuedAt: exp - 1000,
        expiresAt: exp,
      });
    mk("ancient", clock.t - 10 * DAY);
    mk("fresh", clock.t + DAY);
    first.close();
    const second = await openAuthRegistry(cfg, { now: () => clock.t, reapRetired: true });
    expect(
      second.registry
        .listTokens({ includeExpired: true })
        .map((t) => t.jti)
        .sort(),
    ).toEqual(["fresh"]);
    second.close();
  });
});

describe("`auth rotate-key --purpose`", () => {
  let out = "";
  const deployments: string[] = [];
  beforeEach(() => {
    out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((c) => {
      out += String(c);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  function deployment() {
    const root = makeTempDir("auth-purpose-cli-");
    dirs.push(root);
    deployments.push(root);
    const vault = join(root, "vault");
    mkdirSync(vault);
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        vaults: [{ id: "main", path: vault }],
        cacheDir: join(root, "cache"),
        auth: { mode: "jwt", jwtSecret: SECRET },
      }),
    );
    return { configPath, cacheDir: join(root, "cache") };
  }
  const rotateCli = async (configPath: string, extra: Record<string, unknown>) => {
    out = "";
    await run_auth({
      kind: "auth",
      sub: "rotate-key",
      configPath,
      json: true,
      ...extra,
    } as never);
    return JSON.parse(out) as { kid: string; alg: string; previous_kid: string | null };
  };
  const keysOf = async (cacheDir: string) => {
    const { registry, close } = await openAuthRegistry({
      cacheDir,
      db: {},
      auth: { jwtSecret: SECRET },
    } as never);
    const keys = registry.listKeys() as {
      kid: string;
      purpose: string;
      state: string;
      alg: string;
    }[];
    close();
    return keys;
  };

  it("parses --purpose and rejects a bad value or a non-rotate subcommand", () => {
    expect(parseCliArgs(["auth", "rotate-key", "--purpose", "as", "c.json"])).toMatchObject({
      kind: "auth",
      sub: "rotate-key",
      purpose: "as",
    });
    expect(parseCliArgs(["auth", "rotate-key", "--purpose", "bogus"])).toMatchObject({
      kind: "error",
    });
    expect(parseCliArgs(["auth", "list", "--purpose", "as"])).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["auth", "rotate-key", "c.json"])).not.toHaveProperty("purpose");
  });

  it("creates the `as` key as ES256 by default, beside the untouched config mint key", async () => {
    const d = deployment();
    const r = await rotateCli(d.configPath, { purpose: "as" });
    expect(r.alg).toBe("ES256");
    const keys = await keysOf(d.cacheDir);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ purpose: "as", state: "active", alg: "ES256" });
  });

  it("refuses an HS256 `as` key", async () => {
    const d = deployment();
    await expect(rotateCli(d.configPath, { purpose: "as", alg: "HS256" })).rejects.toThrow(/as/);
  });

  it("an omitted --grace on an `as` rotation defaults to the floor; an explicit smaller one is refused", async () => {
    const d = deployment();
    await rotateCli(d.configPath, { purpose: "as" });
    await expect(rotateCli(d.configPath, { purpose: "as", graceSeconds: 30 })).rejects.toThrow(
      /grace/,
    );
    await rotateCli(d.configPath, { purpose: "as" });
    const keys = await keysOf(d.cacheDir);
    expect(keys.filter((k) => k.state === "retiring")).toHaveLength(1);
    expect(keys.filter((k) => k.state === "active")).toHaveLength(1);
  });

  it("`auth list --keys` shows each key's purpose", async () => {
    const d = deployment();
    await rotateCli(d.configPath, { purpose: "as" });
    out = "";
    await run_auth({
      kind: "auth",
      sub: "list",
      keys: true,
      configPath: d.configPath,
      json: true,
    } as never);
    expect(JSON.parse(out)).toEqual([expect.objectContaining({ purpose: "as" })]);
  });
});
