// Opt-in CORS for browser clients on the HTTP transport. Default-off: with no `transports.http.cors`
// origins, no response carries an `Access-Control-*` header. With origins listed, only an exact
// origin match is echoed back (never `*`, and no credentials: the bearer rides in `Authorization`).
// The pins here are the contract a browser sees, not the middleware that produces it.

import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { AS_ROUTES } from "../src/auth/as-metadata";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { type HttpHandle, startHttp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";
import { stallTimeout } from "./stall-timeouts";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const RESOURCE = "https://vault.example.com/mcp";
const ISSUER = "https://vault.example.com";
const ORIGIN = "https://app.example.com";
const ALLOW_METHODS = "POST";
const ALLOW_HEADERS = "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version";
const EXPOSE_HEADERS = "Mcp-Session-Id, WWW-Authenticate, Mcp-Protocol-Version";
const MCP_BODY = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

/** A JWT auth config with the PRM configured, so a 401 carries a `WWW-Authenticate` challenge. */
function authOf(as = false): ServerConfig["auth"] {
  return ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: "/tmp/v1" }],
    auth: {
      mode: "jwt",
      jwtSecret: SECRET,
      audience: RESOURCE,
      resource: RESOURCE,
      scopesSupported: ["read:notes"],
      ...(as ? { as: { enabled: true, issuer: ISSUER } } : {}),
    },
  }).auth as ServerConfig["auth"];
}

const handles: HttpHandle[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close();
});

async function boot(opts: { auth?: ServerConfig["auth"]; corsOrigins?: string[] } = {}) {
  const db = openMemoryDb();
  provisionCacheDb(db);
  const handle = await startHttp({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry: new ToolRegistry(),
    auth: opts.auth ?? authOf(),
    db,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    host: "127.0.0.1",
    port: 0,
    corsOrigins: opts.corsOrigins,
  });
  handles.push(handle);
  return handle;
}

const url = (h: HttpHandle, path: string) => `http://127.0.0.1:${h.port}${path}`;

async function tokenFor(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: "alice",
    scopes: ["read:notes"],
    aud: RESOURCE,
    iat: now,
    exp: now + 600,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(new TextEncoder().encode(SECRET));
}

function mcpPost(h: HttpHandle, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url(h, "/mcp"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      ...headers,
    },
    body: MCP_BODY,
  });
}

function preflight(h: HttpHandle, path: string, origin: string): Promise<Response> {
  return fetch(url(h, path), {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
    },
  });
}

/** Every `access-control-*` header on a response, by name. */
function corsHeaders(res: Response): string[] {
  return [...res.headers.keys()].filter((k) => k.startsWith("access-control-"));
}

describe("CORS off by default", () => {
  it(
    "emits no Access-Control-* header and no Vary on preflight or actual responses",
    async () => {
      const h = await boot();
      const pre = await preflight(h, "/mcp", ORIGIN);
      expect(pre.status).toBe(404);
      expect(corsHeaders(pre)).toEqual([]);
      expect(pre.headers.get("vary")).toBeNull();

      const token = await tokenFor();
      const ok = await mcpPost(h, { origin: ORIGIN, authorization: `Bearer ${token}` });
      expect(ok.status).toBe(403);
      expect(corsHeaders(ok)).toEqual([]);
    },
    stallTimeout(20_000),
  );

  it(
    "keeps the same-origin POST exactly as before: authenticated 200 with no CORS headers",
    async () => {
      const h = await boot();
      const token = await tokenFor();
      const res = await mcpPost(h, { authorization: `Bearer ${token}` });
      expect(res.status).toBe(200);
      expect(corsHeaders(res)).toEqual([]);
      expect(res.headers.get("vary")).toBeNull();
    },
    stallTimeout(20_000),
  );
});

describe("CORS on /mcp for an allowed origin", () => {
  it(
    "answers the preflight with 204 and exactly the contract headers",
    async () => {
      const h = await boot({ corsOrigins: [ORIGIN] });
      const res = await preflight(h, "/mcp", ORIGIN);
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      expect(res.headers.get("vary")).toBe("Origin");
      expect(res.headers.get("access-control-allow-methods")).toBe(ALLOW_METHODS);
      expect(res.headers.get("access-control-allow-headers")).toBe(ALLOW_HEADERS);
      expect(res.headers.get("access-control-max-age")).toBe("600");
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
      expect(corsHeaders(res).sort()).toEqual(
        [
          "access-control-allow-headers",
          "access-control-allow-methods",
          "access-control-allow-origin",
          "access-control-max-age",
        ].sort(),
      );
    },
    stallTimeout(20_000),
  );

  it(
    "challenges an unauthenticated POST with 401 that still carries ACAO and exposes WWW-Authenticate",
    async () => {
      // The PRM (and so the challenge) is configured only with an authorization server.
      const h = await boot({ auth: authOf(true), corsOrigins: [ORIGIN] });
      const res = await mcpPost(h, { origin: ORIGIN });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
      expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      expect(res.headers.get("access-control-expose-headers")).toBe(EXPOSE_HEADERS);
      expect(res.headers.get("vary")).toBe("Origin");
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    },
    stallTimeout(20_000),
  );

  it(
    "adds ACAO, Vary and Expose to an authenticated 200",
    async () => {
      const h = await boot({ corsOrigins: [ORIGIN] });
      const token = await tokenFor();
      const res = await mcpPost(h, { origin: ORIGIN, authorization: `Bearer ${token}` });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      expect(res.headers.get("access-control-expose-headers")).toBe(EXPOSE_HEADERS);
      expect(res.headers.get("vary")).toBe("Origin");
    },
    stallTimeout(20_000),
  );

  it(
    "matches the origin case-insensitively on scheme and host, and drops a default port",
    async () => {
      const h = await boot({ corsOrigins: ["HTTPS://App.Example.com:443"] });
      const res = await preflight(h, "/mcp", ORIGIN);
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    },
    stallTimeout(20_000),
  );
});

describe("CORS and the rebinding guard", () => {
  it(
    "a disallowed origin gets no CORS headers and the existing guard still refuses it",
    async () => {
      const h = await boot({ corsOrigins: [ORIGIN] });
      const pre = await preflight(h, "/mcp", "https://evil.example");
      expect(pre.status).toBe(404);
      expect(corsHeaders(pre)).toEqual([]);

      const res = await mcpPost(h, { origin: "https://evil.example" });
      expect(res.status).toBe(403);
      expect(corsHeaders(res)).toEqual([]);
    },
    stallTimeout(20_000),
  );

  it(
    "matches the exact origin only: the allowed https origin does NOT admit a near miss",
    async () => {
      const h = await boot({ corsOrigins: [ORIGIN] });
      for (const near of [
        "http://app.example.com",
        "https://app.example.com:8443",
        "https://evil.app.example.com",
      ]) {
        const pre = await preflight(h, "/mcp", near);
        expect(pre.status, near).toBe(404);
        expect(corsHeaders(pre), near).toEqual([]);

        const res = await mcpPost(h, { origin: near });
        expect(res.status, near).toBe(403);
        expect(corsHeaders(res), near).toEqual([]);
      }
    },
    stallTimeout(20_000),
  );
});

describe("CORS on the discovery and token routes", () => {
  // Stub the two routes that make the AS issuing (so its metadata and PRM are served), and put the
  // real registrations back afterwards: other tests read the same registry for the PRM challenge.
  let real: typeof AS_ROUTES;
  beforeEach(() => {
    real = new Map(AS_ROUTES);
  });
  afterEach(() => {
    AS_ROUTES.clear();
    for (const [name, mount] of real) AS_ROUTES.set(name, mount);
  });

  it(
    "carries CORS on PRM, AS metadata and the token endpoint, and never on authorize",
    async () => {
      AS_ROUTES.set("token", (app) => {
        app.post("/oauth/token", (c) => c.json({ token: "x" }));
      });
      AS_ROUTES.set("authorize", (app) => {
        app.get("/oauth/authorize", (c) => c.text("page"));
      });
      const h = await boot({ auth: authOf(true), corsOrigins: [ORIGIN] });

      for (const path of [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-authorization-server",
      ]) {
        const res = await fetch(url(h, path), { headers: { origin: ORIGIN } });
        expect(res.status, path).toBe(200);
        expect(res.headers.get("access-control-allow-origin"), path).toBe(ORIGIN);
        expect(res.headers.get("access-control-allow-credentials"), path).toBeNull();
      }

      const pre = await preflight(h, "/oauth/token", ORIGIN);
      expect(pre.status).toBe(204);
      expect(pre.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      expect(pre.headers.get("access-control-allow-methods")).toBe(ALLOW_METHODS);

      const token = await fetch(url(h, "/oauth/token"), {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=refresh_token",
      });
      expect(token.status).toBe(200);
      expect(token.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      expect(token.headers.get("vary")).toBe("Origin");

      const authorize = await fetch(url(h, "/oauth/authorize"), { headers: { origin: ORIGIN } });
      expect(authorize.status).toBe(200);
      expect(corsHeaders(authorize)).toEqual([]);
      const authorizePre = await preflight(h, "/oauth/authorize", ORIGIN);
      expect(authorizePre.status).toBe(404);
      expect(corsHeaders(authorizePre)).toEqual([]);
    },
    stallTimeout(20_000),
  );
});

describe("config: transports.http.cors.allowedOrigins", () => {
  const parse = (allowedOrigins: unknown) =>
    ServerConfigSchema.safeParse({
      vaults: [{ id: "v1", path: "/tmp/v1" }],
      transports: { http: { cors: { allowedOrigins } } },
    });

  it("defaults to no origins", () => {
    const parsed = ServerConfigSchema.parse({ vaults: [{ id: "v1", path: "/tmp/v1" }] });
    expect(parsed.transports.http.cors.allowedOrigins).toEqual([]);
  });

  it.each([
    ["a wildcard", "*"],
    ["a wildcard subdomain", "https://*.example.com"],
    ["a trailing slash", "https://app.example.com/"],
    ["a path", "https://app.example.com/app"],
    ["a query", "https://app.example.com?x=1"],
    ["a non-http(s) scheme", "ftp://app.example.com"],
    ["a bare host with no scheme", "app.example.com"],
  ])("rejects %s", (_label, entry) => {
    expect(parse([entry]).success).toBe(false);
  });

  it("accepts exact origins, with or without a port", () => {
    expect(parse(["https://app.example.com", "http://localhost:5173"]).success).toBe(true);
  });
});
