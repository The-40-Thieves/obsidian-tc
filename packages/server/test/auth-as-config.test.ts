// `auth.as` (bundled authorization server, design v2 section 5) and its load-time cross-checks
// (sections 4.1, 4.4, 4.3 PRM row). Slice S3. Every refusal below is a RED test: on a `main` without
// the block, `auth.as` is silently STRIPPED by the non-strict auth schema, so each of these configs
// validates and the AS would simply never exist.
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const ISSUER = "https://vault.example.com";
const RESOURCE = "https://vault.example.com/mcp";

const config = (auth: Record<string, unknown>) => ({
  vaults: [{ id: "main", path: "/tmp/main" }],
  auth,
});
const jwtAuth = (over: Record<string, unknown> = {}, as: Record<string, unknown> = {}) => ({
  mode: "jwt",
  jwtSecret: SECRET,
  resource: RESOURCE,
  as: { enabled: true, issuer: ISSUER, ...as },
  ...over,
});

/** Parse and return the issues as `path: message` lines ([] when valid). */
function issuesOf(auth: Record<string, unknown>): string[] {
  const r = ServerConfigSchema.safeParse(config(auth));
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

describe("auth.as: shape and defaults", () => {
  it("accepts the minimal enabled block and fills every default of design section 5", () => {
    const r = ServerConfigSchema.safeParse(config(jwtAuth()));
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.auth.as).toEqual({
      enabled: true,
      issuer: ISSUER,
      signingAlg: "ES256",
      accessTokenSeconds: 1800,
      refreshTokenDays: 30,
      dynamicRegistration: false,
      dcr: { maxClients: 1000, perIpPerHour: 10, unusedDays: 90 },
      cimd: { allowedHosts: [] },
      setupTokenEnv: "OBSIDIAN_TC_AS_SETUP_TOKEN",
      login: { maxFailuresPerWindow: 5, windowSeconds: 900 },
      clients: [],
    });
  });

  it("DCR is off by default (owner decision 2)", () => {
    const r = ServerConfigSchema.parse(config(jwtAuth()));
    expect(r.auth.as?.dynamicRegistration).toBe(false);
  });

  it("an absent block means no AS: nothing changes for existing configs", () => {
    const r = ServerConfigSchema.parse(config({ mode: "jwt", jwtSecret: SECRET }));
    expect(r.auth.as).toBeUndefined();
  });

  it("a disabled block is accepted under any mode (it has nothing to protect or conflict with)", () => {
    expect(issuesOf({ mode: "none", as: { enabled: false } })).toEqual([]);
  });

  it.each([
    ["an unknown key (a typo must not be silently ignored)", { dynamicRegistrationn: true }],
    ["accessTokenSeconds below 300", { accessTokenSeconds: 299 }],
    ["accessTokenSeconds above 3600", { accessTokenSeconds: 3601 }],
    ["a non-integer accessTokenSeconds", { accessTokenSeconds: 600.5 }],
    ["refreshTokenDays below 1", { refreshTokenDays: 0 }],
    ["refreshTokenDays above 90", { refreshTokenDays: 91 }],
    ["a signingAlg that is not ES256 or EdDSA", { signingAlg: "HS256" }],
    ["RS256 as the signingAlg", { signingAlg: "RS256" }],
    ["a setupTokenEnv that is not an environment variable name", { setupTokenEnv: "not a name" }],
  ])("refuses %s", (_name, as) => {
    expect(issuesOf(jwtAuth({}, as)).length).toBeGreaterThan(0);
  });

  it("accepts EdDSA and the documented bounds", () => {
    expect(
      issuesOf(
        jwtAuth({ tokenTtlSeconds: 86400 }, { signingAlg: "EdDSA", accessTokenSeconds: 3600 }),
      ),
    ).toEqual([]);
    expect(issuesOf(jwtAuth({}, { accessTokenSeconds: 300, refreshTokenDays: 1 }))).toEqual([]);
  });
});

describe("auth.as.issuer: an https origin, byte-identical everywhere it is used", () => {
  it.each([
    ["a path", "https://vault.example.com/as"],
    ["a trailing slash", "https://vault.example.com/"],
    ["a query", "https://vault.example.com?x=1"],
    ["a fragment", "https://vault.example.com#x"],
    ["credentials", "https://user:pw@vault.example.com"],
    ["an upper-case host (not its canonical form)", "https://Vault.Example.com"],
    ["an explicit default port", "https://vault.example.com:443"],
    ["plain http on a public host", "http://vault.example.com"],
    ["a non-http scheme", "ftp://vault.example.com"],
    ["no scheme", "vault.example.com"],
  ])("refuses an issuer with %s", (_name, issuer) => {
    expect(issuesOf(jwtAuth({}, { issuer })).length).toBeGreaterThan(0);
  });

  it.each([
    "http://127.0.0.1:8080",
    "http://localhost",
    "http://localhost:3000",
    "https://vault.example.com:8443",
  ])("accepts %s", (issuer) => {
    expect(issuesOf(jwtAuth({ resource: `${issuer}/mcp` }, { issuer }))).toEqual([]);
  });

  it("is required when the AS is enabled", () => {
    const issues = issuesOf({
      mode: "jwt",
      jwtSecret: SECRET,
      resource: RESOURCE,
      as: { enabled: true },
    });
    expect(issues.join("\n")).toMatch(/auth\.as\.issuer/);
  });
});

describe("auth.as.enabled needs auth.mode 'jwt' (design 4.1)", () => {
  it("is refused under mode 'none': there is nothing to protect", () => {
    const issues = issuesOf({
      mode: "none",
      resource: RESOURCE,
      as: { enabled: true, issuer: ISSUER },
    });
    expect(issues.join("\n")).toMatch(/auth\.as\.enabled.*'jwt'/);
  });

  it("is refused under mode 'oidc': an external authorization server is already the issuer", () => {
    const issues = issuesOf({
      mode: "oidc",
      oidc: { issuer: "https://idp.example.com", audience: "api://obsidian-tc" },
      resource: RESOURCE,
      as: { enabled: true, issuer: ISSUER },
    });
    expect(issues.join("\n")).toMatch(/auth\.as\.enabled.*'jwt'/);
  });

  it("is accepted under mode 'jwt'", () => {
    expect(issuesOf(jwtAuth())).toEqual([]);
  });
});

describe("auth.as.enabled needs auth.resource (design 4.4 condition 3)", () => {
  it("is refused without one: there is no audience to bind the access tokens to", () => {
    const issues = issuesOf({
      mode: "jwt",
      jwtSecret: SECRET,
      as: { enabled: true, issuer: ISSUER },
    });
    expect(issues.join("\n")).toMatch(/auth\.resource/);
  });
});

describe("tokenTtlSeconds must cover accessTokenSeconds (design 4.4 condition 1)", () => {
  it("refuses tokenTtlSeconds < accessTokenSeconds: the age cap would kill tokens early", () => {
    const issues = issuesOf(jwtAuth({ tokenTtlSeconds: 1799 }));
    expect(issues.join("\n")).toMatch(/tokenTtlSeconds.*accessTokenSeconds/);
  });

  it("uses the configured accessTokenSeconds, not the default", () => {
    expect(issuesOf(jwtAuth({ tokenTtlSeconds: 1000 }, { accessTokenSeconds: 600 }))).toEqual([]);
    expect(
      issuesOf(jwtAuth({ tokenTtlSeconds: 1000 }, { accessTokenSeconds: 1001 })).join("\n"),
    ).toMatch(/tokenTtlSeconds/);
  });

  it("accepts equality", () => {
    expect(issuesOf(jwtAuth({ tokenTtlSeconds: 1800 }))).toEqual([]);
  });

  it("is not checked when the AS is disabled", () => {
    expect(
      issuesOf({ mode: "jwt", jwtSecret: SECRET, tokenTtlSeconds: 60, as: { enabled: false } }),
    ).toEqual([]);
  });
});

describe("auth.algorithms must admit auth.as.signingAlg (design 4.4 condition 2)", () => {
  it("refuses an allowlist that leaves the signing algorithm out", () => {
    const issues = issuesOf(jwtAuth({ algorithms: ["HS256"] }));
    expect(issues.join("\n")).toMatch(/algorithms.*ES256/);
    expect(issuesOf(jwtAuth({ algorithms: ["ES256"] }, { signingAlg: "EdDSA" })).join("\n")).toMatch(
      /algorithms.*EdDSA/,
    );
  });

  it("accepts one that names it, and an absent one", () => {
    expect(issuesOf(jwtAuth({ algorithms: ["HS256", "ES256"] }))).toEqual([]);
    expect(issuesOf(jwtAuth({ algorithms: ["EdDSA"] }, { signingAlg: "EdDSA" }))).toEqual([]);
    expect(issuesOf(jwtAuth())).toEqual([]);
  });
});

describe("authorizationServers[0] must equal the issuer (design 4.3 PRM row; Claude reads only the first)", () => {
  it("refuses a list whose first entry is another server", () => {
    const issues = issuesOf(jwtAuth({ authorizationServers: ["https://other.example", ISSUER] }));
    expect(issues.join("\n")).toMatch(/authorizationServers.*first/);
  });

  it("refuses an issuer that differs by a trailing slash: the string must be byte-identical", () => {
    const issues = issuesOf(jwtAuth({ authorizationServers: [`${ISSUER}/`] }));
    expect(issues.join("\n")).toMatch(/authorizationServers/);
  });

  it("refuses an explicit empty list", () => {
    expect(issuesOf(jwtAuth({ authorizationServers: [] })).join("\n")).toMatch(
      /authorizationServers/,
    );
  });

  it("accepts the issuer first (more entries may follow), or no list at all", () => {
    expect(issuesOf(jwtAuth({ authorizationServers: [ISSUER] }))).toEqual([]);
    expect(issuesOf(jwtAuth({ authorizationServers: [ISSUER, "https://other.example"] }))).toEqual(
      [],
    );
    expect(issuesOf(jwtAuth())).toEqual([]);
  });

  it("is not checked when the AS is disabled", () => {
    expect(
      issuesOf({
        mode: "jwt",
        jwtSecret: SECRET,
        resource: RESOURCE,
        authorizationServers: ["https://other.example"],
        as: { enabled: false, issuer: ISSUER },
      }),
    ).toEqual([]);
  });
});

describe("auth.jwksUri must not be this server's own JWKS (design 4.1)", () => {
  it.each([
    ["the exact URL", `${ISSUER}/.well-known/jwks.json`],
    ["an upper-case host", "https://VAULT.example.com/.well-known/jwks.json"],
    ["an explicit default port", "https://vault.example.com:443/.well-known/jwks.json"],
    ["a trailing dot on the host", "https://vault.example.com./.well-known/jwks.json"],
    ["a query string", `${ISSUER}/.well-known/jwks.json?x=1`],
    ["a fragment", `${ISSUER}/.well-known/jwks.json#k`],
    ["an unnecessarily percent-encoded path", `${ISSUER}/.well-known/%6Awks.json`],
  ])("refuses %s", (_name, jwksUri) => {
    const issues = issuesOf(jwtAuth({ jwksUri }));
    expect(issues.join("\n")).toMatch(/jwksUri.*own/);
  });

  it("accepts another host's JWKS, and the same host's other paths", () => {
    expect(issuesOf(jwtAuth({ jwksUri: "https://idp.example.com/.well-known/jwks.json" }))).toEqual(
      [],
    );
    expect(issuesOf(jwtAuth({ jwksUri: `${ISSUER}/other/jwks.json` }))).toEqual([]);
  });

  it("is not checked when the AS is disabled", () => {
    expect(
      issuesOf({
        mode: "jwt",
        jwtSecret: SECRET,
        resource: RESOURCE,
        jwksUri: `${ISSUER}/.well-known/jwks.json`,
        as: { enabled: false, issuer: ISSUER },
      }),
    ).toEqual([]);
  });
});

describe("auth.as.clients (static clients)", () => {
  const client = (over: Record<string, unknown> = {}) => ({
    clientId: "my-agent",
    name: "My agent",
    redirectUris: ["http://127.0.0.1/callback"],
    ...over,
  });

  it("accepts a loopback, an https and a private-use redirect URI", () => {
    expect(
      issuesOf(
        jwtAuth(
          {},
          {
            clients: [
              client({
                redirectUris: [
                  "http://127.0.0.1/callback",
                  "http://localhost:8123/cb",
                  "http://[::1]/cb",
                  "https://claude.ai/api/mcp/auth_callback",
                  "cursor://anysphere.cursor-retrieval/oauth/callback",
                ],
              }),
            ],
          },
        ),
      ),
    ).toEqual([]);
  });

  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,x"],
    ["plain http on a public host", "http://evil.example/cb"],
    ["a fragment", "https://client.example/cb#frag"],
    ["a relative URI", "/cb"],
  ])("refuses a redirect URI that is %s", (_name, uri) => {
    expect(issuesOf(jwtAuth({}, { clients: [client({ redirectUris: [uri] })] })).length).toBeGreaterThan(
      0,
    );
  });

  it("needs at least one redirect URI, and refuses a duplicate clientId", () => {
    expect(
      issuesOf(jwtAuth({}, { clients: [client({ redirectUris: [] })] })).length,
    ).toBeGreaterThan(0);
    expect(
      issuesOf(jwtAuth({}, { clients: [client(), client({ name: "Other" })] })).join("\n"),
    ).toMatch(/clientId/);
  });

  it("takes a confidential client's secret from an environment variable NAME, never a literal", () => {
    expect(issuesOf(jwtAuth({}, { clients: [client({ secretEnv: "MY_AGENT_SECRET" })] }))).toEqual(
      [],
    );
    expect(
      issuesOf(jwtAuth({}, { clients: [client({ secretEnv: "not an env name" })] })).length,
    ).toBeGreaterThan(0);
    // `secret` is not a key: a literal secret in the config file is refused as unknown.
    expect(
      issuesOf(jwtAuth({}, { clients: [client({ secret: "hunter2hunter2" })] })).length,
    ).toBeGreaterThan(0);
  });
});
