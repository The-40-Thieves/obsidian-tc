// RFC 8414 authorization-server metadata for the bundled AS (design v2 section 4.3), slice S3.
// Acceptance: required RFC 8414 members, Claude's CIMD prerequisites, ChatGPT's hard requirements
// (section 9.1), no `registration_endpoint` while DCR is off, PRM naming the issuer first, and the
// threat-model Host-header-spoofing row. Nothing here issues a token: no issuing route exists yet.
import { request } from "node:http";
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { AS_FEATURES, AS_ROUTES, type AsRouteName } from "../src/auth/as-metadata";
import { redactConfig } from "../src/cli/redact-config";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { type HttpHandle, startHttp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const ISSUER = "https://vault.example.com";
const RESOURCE = "https://vault.example.com/mcp";
const METADATA_PATH = "/.well-known/oauth-authorization-server";
const PRM_PATH = "/.well-known/oauth-protected-resource";

function authOf(over: Record<string, unknown> = {}, as: Record<string, unknown> = {}) {
  return ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: "/tmp/v1" }],
    auth: {
      mode: "jwt",
      jwtSecret: SECRET,
      resource: RESOURCE,
      scopesSupported: ["read:notes", "write:notes"],
      as: { enabled: true, issuer: ISSUER, ...as },
      ...over,
    },
  }).auth as ServerConfig["auth"];
}

const handles: HttpHandle[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close();
  AS_ROUTES.clear();
  AS_FEATURES.clear();
});

/** Stand in for the slices that mount the issuing routes: the capability source is the registry. */
function serve(routes: AsRouteName[], features: Array<"cimd" | "refresh"> = []) {
  for (const r of routes) AS_ROUTES.set(r, () => {});
  for (const f of features) AS_FEATURES.add(f);
}
const serveEverything = () => serve(["authorize", "token", "revoke"], ["cimd", "refresh"]);

async function boot(auth: ServerConfig["auth"]) {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const handle = await startHttp({
    name: "obsidian-tc",
    version: "t",
    registry: new ToolRegistry(),
    auth,
    db,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    host: "127.0.0.1",
    port: 0,
  });
  handles.push(handle);
  return { handle, base: `http://127.0.0.1:${handle.port}` };
}

/** GET with an explicit Host header (fetch will not let a caller choose it). */
function getWithHost(port: number, path: string, host: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET", headers: { host } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => {
          body += d;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

type Meta = Record<string, unknown>;
const metadataOf = async (base: string): Promise<Meta> => {
  const r = await fetch(base + METADATA_PATH);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toMatch(/application\/json/);
  return (await r.json()) as Meta;
};

describe("GET /.well-known/oauth-authorization-server", () => {
  beforeEach(serveEverything);

  it("carries every RFC 8414 required member, all URLs under the issuer", async () => {
    const { base } = await boot(authOf());
    const m = await metadataOf(base);
    expect(m.issuer).toBe(ISSUER);
    expect(m.authorization_endpoint).toBe(`${ISSUER}/oauth/authorize`);
    expect(m.token_endpoint).toBe(`${ISSUER}/oauth/token`);
    expect(m.revocation_endpoint).toBe(`${ISSUER}/oauth/revoke`);
    expect(m.jwks_uri).toBe(`${ISSUER}/.well-known/jwks.json`);
    expect(m.response_types_supported).toEqual(["code"]);
    expect(m.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
  });

  it("meets Claude's CIMD prerequisites and ChatGPT's hard requirements (design 9.1)", async () => {
    const { base } = await boot(authOf());
    const m = await metadataOf(base);
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.authorization_response_iss_parameter_supported).toBe(true);
    expect(m.client_id_metadata_document_supported).toBe(true);
    expect(m.token_endpoint_auth_methods_supported).toContain("none");
    // ChatGPT presents a private_key_jwt assertion on every exchange when it is advertised.
    expect(m.token_endpoint_auth_methods_supported).not.toContain("private_key_jwt");
    // Claude does not support client_credentials and nothing here would honour it.
    expect(m.grant_types_supported).not.toContain("client_credentials");
  });

  it("advertises exactly `none` while no confidential static client is configured", async () => {
    const { base } = await boot(authOf());
    expect((await metadataOf(base)).token_endpoint_auth_methods_supported).toEqual(["none"]);
  });

  it("adds client_secret_basic only when a confidential static client exists", async () => {
    const { base } = await boot(
      authOf(
        {},
        {
          clients: [
            {
              clientId: "svc",
              name: "Service",
              redirectUris: ["http://127.0.0.1/cb"],
              secretEnv: "SVC_SECRET",
            },
          ],
        },
      ),
    );
    expect((await metadataOf(base)).token_endpoint_auth_methods_supported).toEqual([
      "none",
      "client_secret_basic",
    ]);
  });

  it("has NO registration_endpoint while DCR is off (the default)", async () => {
    const { base } = await boot(authOf());
    const m = await metadataOf(base);
    expect("registration_endpoint" in m).toBe(false);
  });

  it("advertises registration_endpoint only when DCR is enabled", async () => {
    serve(["register"]);
    const { base } = await boot(authOf({}, { dynamicRegistration: true }));
    expect((await metadataOf(base)).registration_endpoint).toBe(`${ISSUER}/oauth/register`);
  });

  it("lists the PRM scopes plus offline_access, once each", async () => {
    const { base } = await boot(authOf({ scopesSupported: ["read:notes", "offline_access"] }));
    expect((await metadataOf(base)).scopes_supported).toEqual(["read:notes", "offline_access"]);
    const b2 = await boot(authOf({ scopesSupported: ["read:notes", "write:notes"] }));
    expect((await metadataOf(b2.base)).scopes_supported).toEqual([
      "read:notes",
      "write:notes",
      "offline_access",
    ]);
  });

  it("is also served at the OpenID discovery alias, discovery fields only (no id_token)", async () => {
    const { base } = await boot(authOf());
    const r = await fetch(`${base}/.well-known/openid-configuration`);
    expect(r.status).toBe(200);
    const alias = (await r.json()) as Meta;
    expect(alias).toEqual(await metadataOf(base));
    expect(alias.response_types_supported).not.toContain("id_token");
    expect("userinfo_endpoint" in alias).toBe(false);
    expect("id_token_signing_alg_values_supported" in alias).toBe(false);
  });

  it("is public (no bearer needed), like the PRM and JWKS", async () => {
    const { base } = await boot(authOf());
    expect((await fetch(base + METADATA_PATH)).status).toBe(200);
  });

  it("is NOT served when the AS is disabled, or absent", async () => {
    for (const auth of [authOf({}, { enabled: false }), authOf({ as: undefined })]) {
      const { base } = await boot(auth);
      expect((await fetch(base + METADATA_PATH)).status).toBe(404);
      expect((await fetch(`${base}/.well-known/openid-configuration`)).status).toBe(404);
    }
  });
});

describe("threat row: Host-header spoofing", () => {
  beforeEach(serveEverything);

  it("metadata fetched with `Host: evil.example` still names the configured issuer", async () => {
    const { handle } = await boot(authOf());
    for (const host of ["evil.example", "evil.example:8443", "vault.example.com.evil.example"]) {
      const r = await getWithHost(handle.port, METADATA_PATH, host);
      expect(r.status).toBe(200);
      const m = JSON.parse(r.body) as Meta;
      expect(m.issuer).toBe(ISSUER);
      expect(r.body).not.toContain("evil.example");
    }
  });

  it("an X-Forwarded-Host / X-Forwarded-Proto cannot move the issuer or an endpoint either", async () => {
    const { base } = await boot(authOf());
    const r = await fetch(base + METADATA_PATH, {
      headers: { "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" },
    });
    const text = await r.text();
    expect((JSON.parse(text) as Meta).issuer).toBe(ISSUER);
    expect(text).not.toContain("evil.example");
  });
});

describe("Protected Resource Metadata with the AS enabled (design 4.3 PRM row)", () => {
  beforeEach(serveEverything);

  it("defaults authorization_servers to the issuer, byte-identical to the metadata issuer", async () => {
    const { base } = await boot(authOf());
    const prm = (await (await fetch(base + PRM_PATH)).json()) as Meta;
    expect(prm.authorization_servers).toEqual([ISSUER]);
    expect((prm.authorization_servers as string[])[0]).toBe((await metadataOf(base)).issuer);
    expect(prm.resource).toBe(RESOURCE);
  });

  it("an explicit list keeps the issuer first, and the other entries after it", async () => {
    const { base } = await boot(
      authOf({ authorizationServers: [ISSUER, "https://other.example"] }),
    );
    const prm = (await (await fetch(base + PRM_PATH)).json()) as Meta;
    expect(prm.authorization_servers).toEqual([ISSUER, "https://other.example"]);
  });

  it("with the AS disabled, an unset list still serves no PRM (nothing changed)", async () => {
    const { base } = await boot(authOf({}, { enabled: false }));
    expect((await fetch(base + PRM_PATH)).status).toBe(404);
  });
});

describe("`config show` never prints secrets", () => {
  it("masks jwtSecret and shows only environment variable NAMES for client and setup secrets", () => {
    const env = { SVC_SECRET: "client-secret-value-aaaaaaaa", SETUP: "setup-token-value-bbbbbbbb" };
    const auth = authOf(
      {},
      {
        setupTokenEnv: "SETUP",
        clients: [
          {
            clientId: "svc",
            name: "Service",
            redirectUris: ["http://127.0.0.1/cb"],
            secretEnv: "SVC_SECRET",
          },
        ],
      },
    );
    const shown = JSON.stringify(redactConfig({ auth }), null, 2);
    expect(shown).not.toContain(SECRET);
    expect(shown).toContain('"jwtSecret": "<redacted>"');
    for (const v of Object.values(env)) expect(shown).not.toContain(v);
    expect(shown).toContain("SVC_SECRET");
    expect(shown).toContain("SETUP");
  });
});

describe("buildAsMetadata", () => {
  beforeEach(serveEverything);

  it("is a pure function of config: no request, no environment", async () => {
    const { buildAsMetadata } = await import("../src/auth/as-metadata");
    const a = buildAsMetadata(authOf());
    const b = buildAsMetadata(authOf());
    expect(a).toEqual(b);
    expect(a.issuer).toBe(ISSUER);
  });

  it("refuses to build for a config that is not an enabled AS (fail closed)", async () => {
    const { buildAsMetadata } = await import("../src/auth/as-metadata");
    expect(() => buildAsMetadata(authOf({}, { enabled: false }))).toThrow(/auth\.as/);
    expect(() => buildAsMetadata(authOf({ as: undefined }))).toThrow(/auth\.as/);
  });
});

describe("discovery advertises only what is mounted (review: dead flow)", () => {
  const challengeOf = async (base: string) => {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(r.status).toBe(401);
    return r.headers.get("www-authenticate");
  };
  const discovery = async (base: string) => ({
    metadata: (await fetch(base + METADATA_PATH)).status,
    alias: (await fetch(`${base}/.well-known/openid-configuration`)).status,
    prm: (await fetch(base + PRM_PATH)).status,
    challenge: await challengeOf(base),
  });

  it("enabling auth.as before any issuing route exists changes nothing a client discovers", async () => {
    const off = await boot(authOf({}, { enabled: false }));
    const on = await boot(authOf());
    const before = await discovery(off.base);
    expect(before).toEqual({ metadata: 404, alias: 404, prm: 404, challenge: null });
    expect(await discovery(on.base)).toEqual(before);
  });

  it("authorize alone is not enough: the token route must be mounted too", async () => {
    serve(["authorize"]);
    const { base } = await boot(authOf());
    expect((await discovery(base)).metadata).toBe(404);
    expect((await discovery(base)).prm).toBe(404);
  });

  it("with authorize and token mounted: metadata, PRM [issuer] and the challenge pointer all appear", async () => {
    serve(["authorize", "token"]);
    const { base } = await boot(authOf());
    const d = await discovery(base);
    expect(d).toMatchObject({ metadata: 200, alias: 200, prm: 200 });
    expect(d.challenge).toContain(
      `resource_metadata="${RESOURCE.replace("/mcp", "")}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(((await (await fetch(base + PRM_PATH)).json()) as Meta).authorization_servers).toEqual([
      ISSUER,
    ]);
  });

  it("keeps the RFC 8414 required endpoints but omits revocation, CIMD and refresh until they exist", async () => {
    serve(["authorize", "token"]);
    const { base } = await boot(authOf());
    const m = await metadataOf(base);
    expect(m.authorization_endpoint).toBe(`${ISSUER}/oauth/authorize`);
    expect(m.token_endpoint).toBe(`${ISSUER}/oauth/token`);
    expect(m.issuer).toBe(ISSUER);
    expect(m.response_types_supported).toEqual(["code"]);
    expect("revocation_endpoint" in m).toBe(false);
    expect(m.client_id_metadata_document_supported).not.toBe(true);
    expect(m.grant_types_supported).toEqual(["authorization_code"]);
    expect(m.scopes_supported).not.toContain("offline_access");
  });

  it("each later slice flips exactly its own member", async () => {
    serve(["authorize", "token", "revoke"], ["cimd", "refresh"]);
    const m = await metadataOf((await boot(authOf())).base);
    expect(m.revocation_endpoint).toBe(`${ISSUER}/oauth/revoke`);
    expect(m.client_id_metadata_document_supported).toBe(true);
    expect(m.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
  });

  it("registration_endpoint needs BOTH the flag and a mounted register route", async () => {
    serve(["authorize", "token"]);
    expect(
      "registration_endpoint" in
        (await metadataOf((await boot(authOf({}, { dynamicRegistration: true }))).base)),
    ).toBe(false);
    serve(["register"]);
    expect(
      (await metadataOf((await boot(authOf({}, { dynamicRegistration: true }))).base))
        .registration_endpoint,
    ).toBe(`${ISSUER}/oauth/register`);
  });

  it("mounted route handlers are actually served at the app", async () => {
    AS_ROUTES.set("authorize", (app) => app.get("/oauth/authorize", (c) => c.text("authorize-ok")));
    AS_ROUTES.set("token", (app) => app.post("/oauth/token", (c) => c.text("token-ok")));
    const { base } = await boot(authOf());
    expect(await (await fetch(`${base}/oauth/authorize`)).text()).toBe("authorize-ok");
    expect(await (await fetch(`${base}/oauth/token`, { method: "POST" })).text()).toBe("token-ok");
  });

  it("a route mounter is not called while the AS is disabled", async () => {
    AS_ROUTES.set("authorize", (app) => app.get("/oauth/authorize", (c) => c.text("nope")));
    const { base } = await boot(authOf({}, { enabled: false }));
    expect((await fetch(`${base}/oauth/authorize`)).status).toBe(404);
  });
});
