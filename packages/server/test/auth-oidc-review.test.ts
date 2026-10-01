import {
  grantsScope,
  type ServerConfig,
  ServerConfigSchema,
} from "@the-40-thieves/obsidian-tc-shared";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthRejection, type AuthRejectionReason, claimAt } from "../src/auth/jwt";
import { createOidcVerifier } from "../src/auth/oidc";
import { authKeysDir, createAuthRegistry, createLostAuthRegistry } from "../src/auth/registry";
import { createTokenVerifier } from "../src/auth/verifier";
import { signAndRecord } from "../src/cli/commands/token-mint";
import { provisionAuthDb } from "../src/db/provision";
import { openMemoryDb } from "./helpers";
import { AUDIENCE, ISSUER, type MockIdp, publicResolver, startMockIdp } from "./oidc-mock-provider";
import { makeTempDir, rmTemp } from "./tmp";

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
) =>
  createOidcVerifier(authOf(oidc, auth), {
    fetch: idp.fetch,
    jwksCooldownMs: 0,
    resolveHost: publicResolver,
    warn: () => undefined,
    ...deps,
  });

async function reasonOf(p: Promise<unknown>): Promise<AuthRejectionReason | "accepted" | "other"> {
  try {
    await p;
    return "accepted";
  } catch (e) {
    return e instanceof AuthRejection ? e.reason : "other";
  }
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmTemp(d);
});

/** A registry over an in-memory auth.db with durable markers, so table loss is detectable. */
function registryFixture() {
  const dir = makeTempDir("oidc-review-");
  dirs.push(dir);
  const db = openMemoryDb();
  provisionAuthDb(db);
  const reg = createAuthRegistry(db, { configSecret: "s".repeat(32), keysDir: authKeysDir(dir) });
  return { db, reg };
}
const localClaims = () => {
  const now = Math.floor(Date.now() / 1000);
  return { sub: "agent-1", scopes: ["read:notes"], iat: now, exp: now + 3600 };
};

describe("H1: a lost registry refuses EVERY token, jti or not", () => {
  it("oidc: a wholly lost registry refuses a jti-less token (and a jti-bearing one)", async () => {
    const v = await build({}, { registry: createLostAuthRegistry("/nowhere/auth-keys") });
    expect(await reasonOf(v.verify(await idp.sign({}, { unset: ["jti"] })))).toBe("registry_lost");
    expect(await reasonOf(v.verify(await idp.sign()))).toBe("registry_lost");
  });

  it("oidc: auth_tokens emptied while keys survive refuses a jti-less token", async () => {
    const { db, reg } = registryFixture();
    reg.rotateKey();
    await signAndRecord(reg, localClaims());
    const v = await build({}, { registry: reg });
    expect(await reasonOf(v.verify(await idp.sign({}, { unset: ["jti"] })))).toBe("accepted");
    db.exec("DELETE FROM auth_tokens");
    expect(reg.health().state).toBe("lost");
    expect(await reasonOf(v.verify(await idp.sign({}, { unset: ["jti"] })))).toBe("registry_lost");
    expect(await reasonOf(v.verify(await idp.sign()))).toBe("registry_lost");
  });

  it("oidc: a healthy or never-used registry still admits a jti-less token", async () => {
    const db = openMemoryDb();
    provisionAuthDb(db);
    const v = await build(
      {},
      { registry: createAuthRegistry(db, { configSecret: "s".repeat(32) }) },
    );
    expect(await reasonOf(v.verify(await idp.sign({}, { unset: ["jti"] })))).toBe("accepted");
  });

  it("jwt mode has the same gap closed: a jti-less token is refused when auth_tokens is lost", async () => {
    const { db, reg } = registryFixture();
    reg.rotateKey();
    await signAndRecord(reg, localClaims());
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "ext-1", alg: "ES256", use: "sig" };
    const ext = () =>
      new SignJWT(localClaims())
        .setProtectedHeader({ alg: "ES256", kid: "ext-1" })
        .sign(privateKey);
    const verifier = createTokenVerifier({ jwks: { keys: [jwk] }, registry: reg });
    expect(await reasonOf(verifier.verify(await ext()))).toBe("accepted");

    const signing = reg.signingKey();
    const hs = () =>
      new SignJWT(localClaims())
        .setProtectedHeader({ alg: "HS256", kid: signing.kid })
        .sign(new TextEncoder().encode(signing.secret));
    expect(await reasonOf(verifier.verify(await hs()))).toBe("accepted");

    db.exec("DELETE FROM auth_tokens");
    expect(reg.health().state).toBe("lost");
    expect(await reasonOf(verifier.verify(await ext()))).toBe("registry_lost");
    expect(await reasonOf(verifier.verify(await hs()))).toBe("registry_lost");
  });
});

describe("H2: ID and refresh tokens are refused by their PAYLOAD, not only the JOSE header", () => {
  const now = () => Math.floor(Date.now() / 1000);

  // Keycloak: the JOSE header is `typ: JWT` on every token; the token kind is the payload `typ`.
  const keycloakAccess = () => ({
    typ: "Bearer",
    azp: "vault-client",
    sid: "8f1d",
    session_state: "8f1d",
    acr: "1",
    "allowed-origins": ["https://vault.example.com"],
    realm_access: { roles: ["default-roles-corp"] },
    resource_access: { account: { roles: ["view-profile"] } },
    scope: "email profile",
    preferred_username: "ada",
  });
  const keycloakId = () => ({
    typ: "ID",
    azp: "vault-client",
    aud: AUDIENCE,
    nonce: "n-0S6_WzA2Mj",
    at_hash: "aGFzaC1vZi10aGUtYWNjZXNz",
    sid: "8f1d",
    email_verified: true,
    preferred_username: "ada",
  });

  it("accepts a Keycloak access token (header JWT, payload typ Bearer)", async () => {
    const v = await build();
    expect(await reasonOf(v.verify(await idp.sign(keycloakAccess(), { typ: "JWT" })))).toBe(
      "accepted",
    );
  });

  it("refuses a Keycloak ID token even though its header typ is JWT and aud/azp match", async () => {
    const v = await build({ clientId: "vault-client" });
    expect(await reasonOf(v.verify(await idp.sign(keycloakId(), { typ: "JWT" })))).toBe(
      "invalid_token_type",
    );
  });

  it.each(["ID", "Refresh", "Offline", "Serialized-ID", "Logout"])(
    "refuses a Keycloak payload typ %s",
    async (typ) => {
      const v = await build();
      expect(await reasonOf(v.verify(await idp.sign({ typ }, { typ: "JWT" })))).toBe(
        "invalid_token_type",
      );
    },
  );

  it.each(["nonce", "at_hash", "c_hash"])(
    "refuses any token carrying the ID-token marker %s",
    async (m) => {
      const v = await build();
      expect(await reasonOf(v.verify(await idp.sign({ [m]: "x" }, { typ: "JWT" })))).toBe(
        "invalid_token_type",
      );
      expect(await reasonOf(v.verify(await idp.sign({ [m]: "x" }, { typ: "at+jwt" })))).toBe(
        "invalid_token_type",
      );
    },
  );

  it("refuses a non-string payload typ", async () => {
    const v = await build();
    for (const typ of [5, ["Bearer"], { a: 1 }, true]) {
      expect(await reasonOf(v.verify(await idp.sign({ typ }, { typ: "JWT" })))).toBe(
        "invalid_token_type",
      );
    }
  });

  it("Auth0: an access token (at+jwt, azp, gty, permissions) passes; its ID token (nonce) does not", async () => {
    const v = await build();
    const access = {
      azp: "abc123",
      gty: "client-credentials",
      scope: "read:notes",
      permissions: ["read:notes"],
    };
    expect(await reasonOf(v.verify(await idp.sign(access, { typ: "at+jwt" })))).toBe("accepted");
    const id = {
      aud: AUDIENCE,
      nickname: "ada",
      name: "Ada",
      email: "ada@example.com",
      email_verified: true,
      nonce: "abc",
      sid: "s1",
      updated_at: "2026-09-01T00:00:00.000Z",
    };
    expect(await reasonOf(v.verify(await idp.sign(id, { typ: "JWT" })))).toBe("invalid_token_type");
  });

  it("Entra: a v2 access token (header JWT, ver 2.0, scp) passes; its ID token (nonce) does not", async () => {
    const v = await build({ claimMapping: { scopes: "scp" } });
    const access = {
      ver: "2.0",
      tid: "tenant-guid",
      oid: "object-guid",
      azp: "client-guid",
      azpacr: "0",
      scp: "read:notes",
      rh: "0.AXX",
      uti: "u1",
    };
    expect(await reasonOf(v.verify(await idp.sign(access, { typ: "JWT" })))).toBe("accepted");
    const id = { ver: "2.0", tid: "tenant-guid", oid: "object-guid", nonce: "n", name: "Ada" };
    expect(await reasonOf(v.verify(await idp.sign(id, { typ: "JWT" })))).toBe("invalid_token_type");
  });

  it("Cognito: token_use `id` is refused, `access` is accepted", async () => {
    const v = await build();
    expect(await reasonOf(v.verify(await idp.sign({ token_use: "id" })))).toBe(
      "invalid_token_type",
    );
    expect(await reasonOf(v.verify(await idp.sign({ token_use: "access", client_id: "c" })))).toBe(
      "accepted",
    );
  });

  it("requireAtJwtType still refuses a `JWT` header with an otherwise healthy body", async () => {
    const v = await build({ requireAtJwtType: true });
    expect(await reasonOf(v.verify(await idp.sign(keycloakAccess(), { typ: "JWT" })))).toBe(
      "invalid_token_type",
    );
    expect(await reasonOf(v.verify(await idp.sign({ iat: now() }, { typ: "at+jwt" })))).toBe(
      "accepted",
    );
  });
});

describe("H3: bare role names never become family wildcards", () => {
  const roles = (claimMapping: Record<string, unknown> = {}) =>
    build({ claimMapping: { scopes: "realm_access.roles", ...claimMapping } });

  it("realm roles admin/read/write/* grant nothing without a scopeMap", async () => {
    const v = await roles();
    const id = await v.verify(
      await idp.sign({
        realm_access: { roles: ["admin", "read", "write", "bulk", "*", "foo:bar"] },
      }),
    );
    expect([...id.scopes]).toEqual([]);
    for (const required of ["admin:auth", "read:notes", "write:notes", "bulk:notes"]) {
      expect(grantsScope(id.scopes, required)).toBe(false);
    }
  });

  it("fully-qualified scope strings still pass through, wildcard resource included", async () => {
    const v = await roles();
    const id = await v.verify(
      await idp.sign({ realm_access: { roles: ["read:notes", "write:*", "admin"] } }),
    );
    expect([...id.scopes].sort()).toEqual(["read:notes", "write:*"]);
  });

  it("the OAuth `scope` string: standard OIDC scopes are dropped, qualified ones kept", async () => {
    const v = await build();
    const id = await v.verify(
      await idp.sign({ scope: "openid profile email offline_access read:notes" }),
    );
    expect([...id.scopes]).toEqual(["read:notes"]);
  });

  it("an all-families or all-resources wildcard spelled with a colon is not a scope either", async () => {
    const v = await build();
    const id = await v.verify(await idp.sign({ scope: "*:* *:notes :notes read: unknown:notes" }));
    expect([...id.scopes]).toEqual([]);
  });

  it("scopeMap maps a role to explicit scopes; unmapped bare roles are dropped", async () => {
    const v = await roles({
      scopeMap: { vault_admin: ["admin:auth"], reader: ["read:notes", "read:search"] },
    });
    const id = await v.verify(
      await idp.sign({
        realm_access: { roles: ["vault_admin", "reader", "admin", "offline_access"] },
      }),
    );
    expect([...id.scopes].sort()).toEqual(["admin:auth", "read:notes", "read:search"]);
    expect(grantsScope(id.scopes, "write:notes")).toBe(false);
  });

  it("scopeMap keys are own properties only (constructor, toString, __proto__ map nothing)", async () => {
    const v = await roles({ scopeMap: { reader: ["read:notes"] } });
    const id = await v.verify(
      await idp.sign({
        realm_access: { roles: ["constructor", "toString", "__proto__", "hasOwnProperty"] },
      }),
    );
    expect([...id.scopes]).toEqual([]);
  });

  it("logs each dropped bare value once per verifier, not once per request", async () => {
    const lines: string[] = [];
    const v = await build(
      { claimMapping: { scopes: "realm_access.roles" } },
      { warn: (m: string) => lines.push(m) },
    );
    const token = () => idp.sign({ realm_access: { roles: ["admin", "read"] } });
    await v.verify(await token());
    await v.verify(await token());
    await v.verify(await token());
    expect(lines.length).toBe(2);
    expect(lines.join("\n")).toMatch(/admin/);
    expect(lines.join("\n")).toMatch(/scopeMap/);
  });
});

describe("M4: jwks_uri is pinned and the IdP is not a way into the private network", () => {
  it("refuses a discovered jwks_uri on another host", async () => {
    idp.setDiscovery({ jwks_uri: "https://cdn.other.test/jwks" });
    await expect(build()).rejects.toThrow(/jwks_uri.*(origin|host)|(origin|host).*jwks_uri/i);
  });

  it("refuses the same host on another port (a different origin)", async () => {
    idp.setDiscovery({ jwks_uri: "https://idp.test:8443/jwks" });
    await expect(build()).rejects.toThrow(/jwks_uri/i);
  });

  it("accepts another host only when allowedJwksHosts names it", async () => {
    idp.setDiscovery({ jwks_uri: "https://cdn.other.test/jwks" });
    const v = await build({ allowedJwksHosts: ["cdn.other.test"] });
    expect(v.describe().jwksUri).toBe("https://cdn.other.test/jwks");
    await expect(build({ allowedJwksHosts: ["someone.else.test"] })).rejects.toThrow(/jwks_uri/i);
  });

  it("an explicit auth.oidc.jwksUri is the operator's choice and is not pinned to the issuer host", async () => {
    idp.setDiscovery({ jwks_uri: "https://cdn.other.test/jwks" });
    const v = await build({ jwksUri: `${ISSUER}/custom-jwks` });
    expect(await reasonOf(v.verify(await idp.sign()))).toBe("accepted");
  });

  it.each(["https://user:pw@idp.test/jwks", "https://user@idp.test/jwks"])(
    "refuses a jwks_uri carrying userinfo: %s",
    async (jwks_uri) => {
      idp.setDiscovery({ jwks_uri });
      await expect(build({ allowedJwksHosts: ["idp.test"] })).rejects.toThrow(
        /jwks_uri|credentials|userinfo/i,
      );
    },
  );

  it.each([
    ["10.0.0.5"],
    ["172.16.4.4"],
    ["192.168.1.10"],
    ["127.0.0.1"],
    ["169.254.169.254"],
    ["100.64.0.1"],
    ["0.0.0.0"],
    ["::1"],
    ["fd00:ec2::254"],
    ["fe80::1"],
    ["::ffff:169.254.169.254"],
    ["::ffff:7f00:1"],
  ])("refuses an issuer host that resolves to %s", async (addr) => {
    await expect(build({}, { resolveHost: async () => [addr] })).rejects.toThrow(
      /private|loopback|link-local|internal|not a public/i,
    );
  });

  it("refuses when ANY resolved address is private (a mixed answer)", async () => {
    await expect(
      build({}, { resolveHost: async () => ["93.184.216.34", "10.1.1.1"] }),
    ).rejects.toThrow(/private|internal|public/i);
  });

  it("refuses a host that does not resolve at all (fail closed)", async () => {
    await expect(
      build({}, { resolveHost: async () => Promise.reject(new Error("ENOTFOUND")) }),
    ).rejects.toThrow(/resolve|ENOTFOUND/i);
    await expect(build({}, { resolveHost: async () => [] })).rejects.toThrow(/resolve|address/i);
  });

  it("allowPrivateNetwork: true admits a LAN identity provider", async () => {
    const v = await build({ allowPrivateNetwork: true }, { resolveHost: async () => ["10.0.0.5"] });
    expect(await reasonOf(v.verify(await idp.sign()))).toBe("accepted");
  });

  it("the JWKS fetch is checked too: an IdP that starts resolving privately after boot is refused", async () => {
    let addr = "93.184.216.34";
    const v = await build({}, { resolveHost: async () => [addr] });
    addr = "169.254.169.254";
    expect(await reasonOf(v.verify(await idp.sign()))).toBe("idp_unavailable");
  });

  it("a literal private IP issuer is refused without needing DNS", async () => {
    const seen: string[] = [];
    const spy: typeof fetch = async (u) => {
      seen.push(String(u));
      return new Response("{}", { status: 200 });
    };
    await expect(
      createOidcVerifier(authOf({ issuer: "https://10.0.0.5" }), {
        fetch: spy,
        resolveHost: publicResolver,
      }),
    ).rejects.toThrow(/private|internal|public/i);
    expect(seen).toEqual([]);
  });

  it("never follows a cross-origin redirect on the JWKS fetch", async () => {
    idp.setJwksResponse({ status: 302, headers: { location: "https://evil.test/jwks" } });
    const v = await build();
    expect(await reasonOf(v.verify(await idp.sign()))).toBe("idp_unavailable");
  });

  it("never follows a cross-origin redirect on discovery", async () => {
    idp.setDiscoveryResponse({ status: 307, headers: { location: "https://evil.test/d" } });
    await expect(build()).rejects.toThrow(/redirect/i);
  });
});

describe("M5: a dotted claim path walks nested objects only", () => {
  it("claimAt: a top-level claim literally named `a.b` does not shadow {a:{b}}", () => {
    const payload = { "a.b": "attacker", a: { b: "idp" } };
    expect(claimAt(payload, "a.b")).toBe("idp");
    expect(claimAt({ "a.b": "attacker" }, "a.b")).toBeUndefined();
  });

  it("claimAt: an array path is literal segments, so a namespaced name resolves", () => {
    expect(claimAt({ "https://x.example/roles": ["r"] }, ["https://x.example/roles"])).toEqual([
      "r",
    ]);
    expect(
      claimAt({ "https://x.example/roles": ["r"] }, "https://x.example/roles"),
    ).toBeUndefined();
    expect(claimAt({ "a.b": { c: 1 } }, ["a.b", "c"])).toBe(1);
  });

  it("claimAt: own properties only", () => {
    expect(claimAt({}, "constructor")).toBeUndefined();
    expect(claimAt({ a: {} }, "a.constructor.name")).toBeUndefined();
    expect(claimAt({}, ["__proto__"])).toBeUndefined();
  });

  it("a forged top-level `realm_access.roles` grants nothing when the nested claim is the source", async () => {
    const v = await build({
      claimMapping: { scopes: "realm_access.roles", scopeMap: { boss: ["admin:auth"] } },
    });
    const forged = await v.verify(await idp.sign({ "realm_access.roles": ["boss"] }));
    expect([...forged.scopes]).toEqual([]);
    const both = await v.verify(
      await idp.sign({ "realm_access.roles": ["boss"], realm_access: { roles: [] } }),
    );
    expect([...both.scopes]).toEqual([]);
  });

  it("Auth0 namespaced claims use the array form", async () => {
    const ns = "https://vault.example.com/roles";
    const v = await build({
      claimMapping: { scopes: [ns], scopeMap: { editor: ["write:notes"] } },
    });
    const id = await v.verify(await idp.sign({ [ns]: ["editor", "admin"] }));
    expect([...id.scopes]).toEqual(["write:notes"]);
    // The plain-string spelling of the same name is a dotted path, and finds nothing.
    const asString = await build({
      claimMapping: { scopes: ns, scopeMap: { editor: ["write:notes"] } },
    });
    expect([...(await asString.verify(await idp.sign({ [ns]: ["editor"] }))).scopes]).toEqual([]);
  });

  it("subject, principal and requiredClaims take the array form too", async () => {
    const ns = "https://vault.example.com/uid";
    const v = await build({
      claimMapping: { subject: [ns], principal: ["https://vault.example.com/mail"] },
      requiredClaims: [[ns]],
    });
    const id = await v.verify(
      await idp.sign({ [ns]: "u-1", "https://vault.example.com/mail": "a@b.c" }),
    );
    expect(id.caller).toBe("a@b.c");
    expect(await reasonOf(v.verify(await idp.sign({}, { unset: ["sub"] })))).toBe("missing_claim");
  });
});

describe("M6: persona and vault claims are bearer capabilities and need an allowlist", () => {
  const mapped = (over: Record<string, unknown> = {}) =>
    build({
      claimMapping: {
        persona: "obsidian_persona",
        allowedPersonas: ["researcher"],
        vault: "obsidian_vault",
        allowedVaults: ["v1"],
        ...over,
      },
    });

  it("a persona/vault inside the allowlists is mapped", async () => {
    const v = await mapped();
    const id = await v.verify(
      await idp.sign({ obsidian_persona: "researcher", obsidian_vault: "v1" }),
    );
    expect(id).toMatchObject({ persona: "researcher", vault: "v1" });
  });

  it("a persona outside the allowlist REJECTS the token, it is not ignored", async () => {
    const v = await mapped();
    expect(await reasonOf(v.verify(await idp.sign({ obsidian_persona: "root" })))).toBe(
      "claim_not_allowed",
    );
  });

  it("a vault outside the allowlist REJECTS the token", async () => {
    const v = await mapped();
    expect(await reasonOf(v.verify(await idp.sign({ obsidian_vault: "secret-vault" })))).toBe(
      "claim_not_allowed",
    );
  });

  it("a present-but-malformed value rejects: array, number, empty string", async () => {
    const v = await mapped();
    for (const bad of [["researcher"], 7, "", { a: 1 }]) {
      expect(await reasonOf(v.verify(await idp.sign({ obsidian_persona: bad })))).toBe(
        "claim_not_allowed",
      );
      expect(await reasonOf(v.verify(await idp.sign({ obsidian_vault: bad })))).toBe(
        "claim_not_allowed",
      );
    }
  });

  it("absent claims stay absent (no persona, default vault binding)", async () => {
    const v = await mapped();
    const id = await v.verify(await idp.sign());
    expect(id.persona).toBeUndefined();
    expect(id.vault).toBeUndefined();
  });
});

describe("L7: requiredClaims checks the value, not only presence", () => {
  it("the array form demands a truthy, non-empty value", async () => {
    const v = await build({ requiredClaims: ["email_verified"] });
    expect(await reasonOf(v.verify(await idp.sign({ email_verified: true })))).toBe("accepted");
    for (const bad of [false, null, 0, "", [], {}]) {
      expect(await reasonOf(v.verify(await idp.sign({ email_verified: bad })))).toBe(
        "missing_claim",
      );
    }
    expect(await reasonOf(v.verify(await idp.sign({})))).toBe("missing_claim");
  });

  it("the object form demands an exact value", async () => {
    const v = await build({ requiredClaims: { email_verified: true, hd: "example.com" } });
    expect(
      await reasonOf(v.verify(await idp.sign({ email_verified: true, hd: "example.com" }))),
    ).toBe("accepted");
    expect(
      await reasonOf(v.verify(await idp.sign({ email_verified: false, hd: "example.com" }))),
    ).toBe("missing_claim");
    expect(
      await reasonOf(v.verify(await idp.sign({ email_verified: "true", hd: "example.com" }))),
    ).toBe("missing_claim");
    expect(await reasonOf(v.verify(await idp.sign({ email_verified: true, hd: "evil.com" })))).toBe(
      "missing_claim",
    );
    expect(await reasonOf(v.verify(await idp.sign({ email_verified: true })))).toBe(
      "missing_claim",
    );
  });

  it("the object form matches a member of an array claim (groups)", async () => {
    const v = await build({ requiredClaims: { groups: "vault-users" } });
    expect(await reasonOf(v.verify(await idp.sign({ groups: ["x", "vault-users"] })))).toBe(
      "accepted",
    );
    expect(await reasonOf(v.verify(await idp.sign({ groups: ["x"] })))).toBe("missing_claim");
  });

  it("the object form walks a dotted path", async () => {
    const v = await build({ requiredClaims: { "realm_access.tier": "gold" } });
    expect(await reasonOf(v.verify(await idp.sign({ realm_access: { tier: "gold" } })))).toBe(
      "accepted",
    );
    expect(await reasonOf(v.verify(await idp.sign({ "realm_access.tier": "gold" })))).toBe(
      "missing_claim",
    );
  });
});

describe("L8: a non-string JOSE typ is refused", () => {
  const withTyp = async (typ: unknown, o: { requireAt?: boolean } = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: "u",
      scope: "read:notes",
      iat: now,
      exp: now + 60,
    })
      .setProtectedHeader({ alg: "ES256", kid: "k1", typ } as never)
      .sign(idp.privateKey);
    const v = await build(o.requireAt ? { requireAtJwtType: true } : {});
    return reasonOf(v.verify(token));
  };

  it.each([[5], [true], [["at+jwt"]], [{ a: 1 }], [null]])("refuses typ %j", async (typ) => {
    expect(await withTyp(typ)).toBe("invalid_token_type");
  });
  it("still accepts a string typ", async () => {
    expect(await withTyp("at+jwt")).toBe("accepted");
  });
});
