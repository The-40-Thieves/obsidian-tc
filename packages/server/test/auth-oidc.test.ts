// `auth.mode: "oidc"` verification against a MOCK OIDC provider (real sockets, real jose keys).
// Verification only: no authorization server here. Each rejection case asserts the typed reason an
// operator sees; the HTTP edge collapses all of them into one undifferentiated 401 (auth-oidc-http).
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthRejection, type AuthRejectionReason } from "../src/auth/jwt";
import { createOidcVerifier } from "../src/auth/oidc";
import { discoverOidc } from "../src/auth/oidc-discovery";
import { createAuthRegistry } from "../src/auth/registry";
import { provisionAuthDb } from "../src/db/provision";
import { openMemoryDb } from "./helpers";
import { AUDIENCE, ISSUER, type MockIdp, startMockIdp } from "./oidc-mock-provider";

let idp: MockIdp;
beforeEach(async () => {
  idp = await startMockIdp();
});
afterEach(() => idp.close());

function authOf(
  oidc: Record<string, unknown> = {},
  auth: Record<string, unknown> = {},
): ServerConfig["auth"] {
  return ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: "/tmp/v1" }],
    auth: { mode: "oidc", oidc: { issuer: ISSUER, audience: AUDIENCE, ...oidc }, ...auth },
  }).auth;
}
const build = (
  oidc?: Record<string, unknown>,
  deps: Record<string, unknown> = {},
  auth?: Record<string, unknown>,
) => createOidcVerifier(authOf(oidc, auth), { fetch: idp.fetch, jwksCooldownMs: 0, ...deps });

async function reasonOf(p: Promise<unknown>): Promise<AuthRejectionReason | "accepted" | "other"> {
  try {
    await p;
    return "accepted";
  } catch (e) {
    return e instanceof AuthRejection ? e.reason : "other";
  }
}

describe("oidc: token validation", () => {
  it("accepts a healthy access token and maps sub + space-delimited scope", async () => {
    const v = await build();
    const id = await v.verify(await idp.sign({ scope: "read:notes write:notes" }));
    expect(id.caller).toBe("user-1");
    expect([...id.scopes].sort()).toEqual(["read:notes", "write:notes"]);
    expect(id.jti).toBeDefined();
  });

  it("rejects an expired token", async () => {
    const v = await build({ clockToleranceSeconds: 0 });
    const t = await idp.sign({ exp: Math.floor(Date.now() / 1000) - 10 });
    expect(await reasonOf(v.verify(t))).toBe("token_expired");
  });

  it("clock tolerance: a token expired 5s ago passes with 30s tolerance, not with 0", async () => {
    const t = await idp.sign({ exp: Math.floor(Date.now() / 1000) - 5 });
    expect(await reasonOf((await build({ clockToleranceSeconds: 30 })).verify(t))).toBe("accepted");
    expect(await reasonOf((await build({ clockToleranceSeconds: 0 })).verify(t))).toBe(
      "token_expired",
    );
  });

  it("rejects a not-yet-valid token (nbf), tolerating skew inside the window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const v = await build({ clockToleranceSeconds: 30 });
    expect(await reasonOf(v.verify(await idp.sign({ nbf: now + 3600 })))).toBe(
      "token_not_yet_valid",
    );
    expect(await reasonOf(v.verify(await idp.sign({ nbf: now + 5 })))).toBe("accepted");
  });

  it("rejects an iat from the future beyond the tolerance", async () => {
    const now = Math.floor(Date.now() / 1000);
    const v = await build({ clockToleranceSeconds: 30 });
    expect(await reasonOf(v.verify(await idp.sign({ iat: now + 3600, exp: now + 7200 })))).toBe(
      "token_not_yet_valid",
    );
  });

  it("requires exp and iat (RFC 9068), and enforces the age cap from iat", async () => {
    const v = await build();
    expect(await reasonOf(v.verify(await idp.sign({}, { unset: ["exp"] })))).toBe("missing_claim");
    expect(await reasonOf(v.verify(await idp.sign({}, { unset: ["iat"] })))).toBe("missing_claim");
    const now = Math.floor(Date.now() / 1000);
    const old = await idp.sign({ iat: now - 200_000, exp: now + 600 });
    expect(await reasonOf(v.verify(old))).toBe("token_max_age");
  });

  it("rejects a wrong issuer", async () => {
    const v = await build();
    expect(await reasonOf(v.verify(await idp.sign({ iss: "https://evil.test" })))).toBe(
      "issuer_mismatch",
    );
    // Exact, not prefix/normalised: a trailing slash is a different issuer.
    expect(await reasonOf(v.verify(await idp.sign({ iss: `${ISSUER}/` })))).toBe("issuer_mismatch");
  });

  it("rejects a wrong audience; accepts an aud array that contains ours", async () => {
    const v = await build();
    expect(await reasonOf(v.verify(await idp.sign({ aud: "https://other.example.com" })))).toBe(
      "audience_mismatch",
    );
    expect(
      await reasonOf(v.verify(await idp.sign({ aud: ["https://other.example.com", AUDIENCE] }))),
    ).toBe("accepted");
    expect(await reasonOf(v.verify(await idp.sign({}, { unset: ["aud"] })))).toBe("missing_claim");
  });

  it("rejects alg none", async () => {
    const v = await build();
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const none = `${b64({ alg: "none", typ: "at+jwt" })}.${b64({ iss: ISSUER, aud: AUDIENCE, sub: "x", scope: "admin:all", iat: now, exp: now + 60 })}.`;
    expect(await reasonOf(v.verify(none))).not.toBe("accepted");
  });

  it("rejects HS256 signed with the IdP's public key as the secret (alg confusion)", async () => {
    const v = await build();
    const now = Math.floor(Date.now() / 1000);
    for (const secret of [
      JSON.stringify(idp.publicJwk),
      idp.publicJwk.x as string,
      "x".repeat(32),
    ]) {
      const hs = await new SignJWT({
        iss: ISSUER,
        aud: AUDIENCE,
        sub: "mallory",
        scope: "admin:all",
        iat: now,
        exp: now + 60,
      })
        .setProtectedHeader({ alg: "HS256", kid: "k1" })
        .sign(new TextEncoder().encode(secret));
      expect(await reasonOf(v.verify(hs))).toBe("unsupported_alg");
    }
  });

  it("HS256 stays refused even when a jwtSecret is configured beside oidc", async () => {
    const secret = "s".repeat(32);
    const v = await build({}, {}, { jwtSecret: secret });
    const now = Math.floor(Date.now() / 1000);
    const hs = await new SignJWT({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "m",
      scope: "admin:all",
      iat: now,
      exp: now + 60,
    })
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode(secret));
    expect(await reasonOf(v.verify(hs))).toBe("unsupported_alg");
  });

  it("the allowlist comes from config: an alg outside it is refused even with a valid signature", async () => {
    const rsa = await generateKeyPair("RS256");
    idp.publish({ ...(await exportJWK(rsa.publicKey)), kid: "rsa", alg: "RS256" });
    const token = await idp.sign({}, { alg: "RS256", kid: "rsa", key: rsa.privateKey });
    expect(await reasonOf((await build({ allowedAlgs: ["ES256"] })).verify(token))).toBe(
      "unsupported_alg",
    );
    expect(await reasonOf((await build({ allowedAlgs: ["RS256", "ES256"] })).verify(token))).toBe(
      "accepted",
    );
  });

  it("rejects a token signed by a key that is not in the JWKS", async () => {
    const rogue = await generateKeyPair("ES256");
    const v = await build();
    expect(await reasonOf(v.verify(await idp.sign({}, { key: rogue.privateKey })))).toBe(
      "bad_signature",
    );
  });

  it("unknown kid: refetches the JWKS once, then fails; a rotated-in key is then accepted", async () => {
    const v = await build();
    await v.verify(await idp.sign()); // warm the cache
    const before = idp.hits.jwks;
    const next = await generateKeyPair("ES256");
    const nextToken = await idp.sign({}, { kid: "k2", key: next.privateKey });
    expect(await reasonOf(v.verify(nextToken))).toBe("unknown_key");
    expect(idp.hits.jwks).toBeGreaterThan(before); // it did refetch
    idp.publish({ ...(await exportJWK(next.publicKey)), kid: "k2", alg: "ES256" });
    expect(await reasonOf(v.verify(nextToken))).toBe("accepted");
  });

  it("the JWKS refetch on an unknown kid is rate limited by the cooldown (no fetch amplification)", async () => {
    const v = await build({}, { jwksCooldownMs: 60_000 });
    await v.verify(await idp.sign());
    const before = idp.hits.jwks;
    const junk = await generateKeyPair("ES256");
    for (let i = 0; i < 5; i++)
      await reasonOf(v.verify(await idp.sign({}, { kid: `x${i}`, key: junk.privateKey })));
    expect(idp.hits.jwks).toBe(before);
  });

  it("fails closed when the JWKS cannot be fetched", async () => {
    idp.setJwksResponse({ status: 500, body: "boom" });
    const v = await build();
    expect(await reasonOf(v.verify(await idp.sign()))).toBe("idp_unavailable");
    idp.setJwksResponse({ body: "not json" });
    expect(await reasonOf(v.verify(await idp.sign()))).not.toBe("accepted");
  });

  it("fails closed when the JWKS host hangs (timeout)", async () => {
    idp.setJwksResponse({ hang: true });
    const v = await build({}, { timeoutMs: 150 });
    expect(await reasonOf(v.verify(await idp.sign()))).toBe("idp_unavailable");
  });

  it("rejects an oversized JWKS", async () => {
    idp.setJwksResponse({
      body: JSON.stringify({ keys: [idp.publicJwk], pad: "x".repeat(300_000) }),
    });
    const v = await build();
    expect(await reasonOf(v.verify(await idp.sign()))).toBe("idp_unavailable");
  });

  it("uses the jwksUri override instead of the discovered jwks_uri", async () => {
    idp.setDiscovery({ jwks_uri: `${ISSUER}/does-not-exist` });
    const v = await build({ jwksUri: `${ISSUER}/custom-jwks` });
    expect(await reasonOf(v.verify(await idp.sign()))).toBe("accepted");
  });
});

describe("oidc: type, client and claim policy", () => {
  it("typ: at+jwt, application/at+jwt, JWT and absent are accepted by default; others are not", async () => {
    const v = await build();
    for (const typ of ["at+jwt", "AT+JWT", "application/at+jwt", "JWT", "Bearer", null]) {
      expect(await reasonOf(v.verify(await idp.sign({}, { typ })))).toBe("accepted");
    }
    for (const typ of ["id_token+jwt", "secevent+jwt", "logout+jwt", "ID", "Refresh"]) {
      expect(await reasonOf(v.verify(await idp.sign({}, { typ })))).toBe("invalid_token_type");
    }
  });

  it("requireAtJwtType demands RFC 9068 at+jwt strictly", async () => {
    const v = await build({ requireAtJwtType: true });
    expect(await reasonOf(v.verify(await idp.sign({}, { typ: "at+jwt" })))).toBe("accepted");
    expect(await reasonOf(v.verify(await idp.sign({}, { typ: "application/at+jwt" })))).toBe(
      "accepted",
    );
    expect(await reasonOf(v.verify(await idp.sign({}, { typ: "JWT" })))).toBe("invalid_token_type");
    expect(await reasonOf(v.verify(await idp.sign({}, { typ: null })))).toBe("invalid_token_type");
  });

  it("clientId: token client_id or azp must equal it; absent or different is refused", async () => {
    const v = await build({ clientId: "app-1" });
    expect(await reasonOf(v.verify(await idp.sign({ client_id: "app-1" })))).toBe("accepted");
    expect(await reasonOf(v.verify(await idp.sign({ azp: "app-1" })))).toBe("accepted");
    expect(await reasonOf(v.verify(await idp.sign({ client_id: "app-2" })))).toBe(
      "client_mismatch",
    );
    expect(await reasonOf(v.verify(await idp.sign({})))).toBe("client_mismatch");
  });

  it("requiredClaims must be present", async () => {
    const v = await build({ requiredClaims: ["email"] });
    expect(await reasonOf(v.verify(await idp.sign({ email: "a@b.c" })))).toBe("accepted");
    expect(await reasonOf(v.verify(await idp.sign({})))).toBe("missing_claim");
  });

  it("a token with no subject is refused (an unattributable caller is never authenticated)", async () => {
    const v = await build();
    expect(await reasonOf(v.verify(await idp.sign({}, { unset: ["sub"] })))).toBe("missing_claim");
  });
});

describe("oidc: claim mapping", () => {
  it("scp as a space-delimited string (Entra shape)", async () => {
    const v = await build({ claimMapping: { scopes: "scp" } });
    const id = await v.verify(
      await idp.sign({ scp: "read:notes write:notes" }, { unset: ["scope"] }),
    );
    expect([...id.scopes].sort()).toEqual(["read:notes", "write:notes"]);
  });

  it("scope as an array (Auth0 permissions / Keycloak shape)", async () => {
    const v = await build({ claimMapping: { scopes: "permissions" } });
    const id = await v.verify(await idp.sign({ permissions: ["read:notes", "bulk:*", 7, null] }));
    expect([...id.scopes].sort()).toEqual(["bulk:*", "read:notes"]);
  });

  it("dotted path into a nested claim (Keycloak realm_access.roles)", async () => {
    const v = await build({ claimMapping: { scopes: "realm_access.roles" } });
    const id = await v.verify(await idp.sign({ realm_access: { roles: ["read:notes"] } }));
    expect([...id.scopes]).toEqual(["read:notes"]);
  });

  it("a namespaced claim whose NAME contains dots and slashes matches exactly first", async () => {
    const name = "https://vault.example.com/scopes";
    const v = await build({ claimMapping: { scopes: name } });
    const id = await v.verify(await idp.sign({ [name]: ["write:notes"] }));
    expect([...id.scopes]).toEqual(["write:notes"]);
  });

  it("only the mapped claim grants scopes: a stray `scopes` array or `scope` string grants nothing", async () => {
    const v = await build({ claimMapping: { scopes: "scp" } });
    const id = await v.verify(await idp.sign({ scopes: ["admin:all"], scope: "admin:all" }));
    expect(id.scopes.size).toBe(0);
  });

  it("a mapped scope claim of the wrong type grants nothing", async () => {
    const v = await build();
    expect((await v.verify(await idp.sign({ scope: { a: 1 } }))).scopes.size).toBe(0);
    expect((await v.verify(await idp.sign({}, { unset: ["scope"] }))).scopes.size).toBe(0);
  });

  it("principal replaces the caller label; vault and persona map only when configured", async () => {
    const plain = await build();
    const p = await plain.verify(await idp.sign({ email: "a@b.c", vault: "v9", persona: "root" }));
    expect(p.caller).toBe("user-1");
    expect(p.vault).toBeUndefined();
    expect(p.persona).toBeUndefined();
    const mapped = await build({
      claimMapping: { principal: "email", vault: "obsidian_vault", persona: "obsidian_persona" },
    });
    const m = await mapped.verify(
      await idp.sign({ email: "a@b.c", obsidian_vault: "v1", obsidian_persona: "researcher" }),
    );
    expect(m).toMatchObject({ caller: "a@b.c", vault: "v1", persona: "researcher" });
  });

  it("a custom subject claim is required and used", async () => {
    const v = await build({ claimMapping: { subject: "oid" } });
    expect((await v.verify(await idp.sign({ oid: "guid-1" }))).caller).toBe("guid-1");
    expect(await reasonOf(v.verify(await idp.sign({ oid: undefined })))).toBe("missing_claim");
  });
});

describe("oidc: revocation and requireJti share the registry", () => {
  const registryFixture = () => {
    const db = openMemoryDb();
    provisionAuthDb(db);
    return createAuthRegistry(db, { configSecret: "s".repeat(32) });
  };

  it("a jti revoked in the registry (tombstone: this registry never issued it) is refused", async () => {
    const registry = registryFixture();
    const v = await build({}, { registry });
    const t = await idp.sign({ jti: "idp-jti-1" });
    expect(await reasonOf(v.verify(t))).toBe("accepted");
    expect(registry.revoke("idp-jti-1", "compromised")).toBe("tombstoned");
    expect(await reasonOf(v.verify(t))).toBe("token_revoked");
    expect(await reasonOf(v.verify(await idp.sign({ jti: "idp-jti-2" })))).toBe("accepted");
  });

  it("auth.requireJti refuses a token with no jti", async () => {
    const v = await build({}, {}, { requireJti: true });
    expect(await reasonOf(v.verify(await idp.sign({}, { unset: ["jti"] })))).toBe("jti_required");
    expect(await reasonOf(v.verify(await idp.sign()))).toBe("accepted");
  });

  it("a registry that cannot answer refuses the token (fail closed)", async () => {
    const db = openMemoryDb(); // auth tables never provisioned
    const registry = createAuthRegistry(db, { configSecret: "s".repeat(32) });
    const v = await build({}, { registry });
    expect(await reasonOf(v.verify(await idp.sign()))).not.toBe("accepted");
  });
});

describe("oidc: discovery", () => {
  const boot = (over: Record<string, unknown> = {}, deps: Record<string, unknown> = {}) =>
    build(over, deps);

  it("fetches <issuer>/.well-known/openid-configuration and validates the document issuer EXACTLY", async () => {
    const d = await discoverOidc(ISSUER, { fetch: idp.fetch });
    expect(d.issuer).toBe(ISSUER);
    expect(d.jwksUri).toBe(`${ISSUER}/jwks`);
    idp.setDiscovery({ issuer: `${ISSUER}/` });
    await expect(boot()).rejects.toThrow(/issuer.*does not match|mismatch/i);
    idp.setDiscovery({ issuer: "https://evil.test" });
    await expect(boot()).rejects.toThrow(/issuer/i);
  });

  it("an issuer with a path appends the well-known suffix after stripping a trailing slash", async () => {
    const seen: string[] = [];
    const spy: typeof fetch = async (u) => {
      seen.push(String(u));
      return new Response(
        JSON.stringify({ issuer: "https://idp.test/realms/x", jwks_uri: "https://idp.test/jwks" }),
        {
          status: 200,
        },
      );
    };
    await discoverOidc("https://idp.test/realms/x/", { fetch: spy }).catch(() => undefined);
    expect(seen).toEqual(["https://idp.test/realms/x/.well-known/openid-configuration"]);
  });

  it("refuses discovery over http (module level, independent of the schema)", async () => {
    await expect(discoverOidc("http://idp.test", { fetch: idp.fetch })).rejects.toThrow(/https/i);
    await expect(discoverOidc("http://127.0.0.1:1", { fetch: idp.fetch })).rejects.toThrow(
      /https/i,
    );
  });

  it("refuses a jwks_uri that is not https, and a document without one", async () => {
    idp.setDiscovery({ jwks_uri: "http://idp.test/jwks" });
    await expect(boot()).rejects.toThrow(/jwks_uri/);
    idp.setDiscovery({ jwks_uri: undefined });
    await expect(boot()).rejects.toThrow(/jwks_uri/);
  });

  it("fails closed at boot when discovery fails, naming the issuer", async () => {
    idp.setDiscoveryResponse({ status: 500, body: "nope" });
    await expect(boot()).rejects.toThrow(new RegExp(`${ISSUER}.*(500|discovery)`, "i"));
    idp.setDiscoveryResponse({ body: "<html>" });
    await expect(boot()).rejects.toThrow(/json/i);
    idp.setDiscoveryResponse({ body: "[]" });
    await expect(boot()).rejects.toThrow(/discovery/i);
  });

  it("does not follow redirects", async () => {
    idp.setDiscoveryResponse({ status: 302, headers: { location: "https://evil.test/x" } });
    await expect(boot()).rejects.toThrow(/redirect|302/i);
  });

  it("rejects an oversized discovery document", async () => {
    idp.setDiscoveryResponse({
      body: JSON.stringify({
        issuer: ISSUER,
        jwks_uri: `${ISSUER}/jwks`,
        pad: "x".repeat(100_000),
      }),
    });
    await expect(boot()).rejects.toThrow(/too large|size|exceed/i);
  });

  it("times out a hanging discovery endpoint", async () => {
    idp.setDiscoveryResponse({ hang: true });
    await expect(boot({}, { timeoutMs: 150 })).rejects.toThrow(/timed out|timeout|abort/i);
  });

  it("the document is cached for the TTL, then refreshed; a failed refresh fails closed", async () => {
    let now = 1_000_000;
    const v = await build({ discoveryCacheSeconds: 60 }, { now: () => now });
    expect(idp.hits.discovery).toBe(1);
    await v.verify(await idp.sign());
    await v.verify(await idp.sign());
    expect(idp.hits.discovery).toBe(1);
    now += 61_000;
    await v.verify(await idp.sign());
    expect(idp.hits.discovery).toBe(2);
    now += 61_000;
    idp.setDiscoveryResponse({ status: 500, body: "" });
    expect(await reasonOf(v.verify(await idp.sign()))).toBe("idp_unavailable");
  });

  it("a refreshed document whose issuer changed is refused", async () => {
    let now = 1_000_000;
    const v = await build({ discoveryCacheSeconds: 60 }, { now: () => now });
    now += 61_000;
    idp.setDiscovery({ issuer: "https://evil.test" });
    expect(await reasonOf(v.verify(await idp.sign()))).toBe("idp_unavailable");
  });

  it("exposes what it discovered for the startup log", async () => {
    const v = await build();
    expect(v.describe()).toMatchObject({
      issuer: ISSUER,
      jwksUri: `${ISSUER}/jwks`,
      audience: AUDIENCE,
    });
  });
});
