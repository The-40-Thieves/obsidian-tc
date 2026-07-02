import { serve } from "@hono/node-server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  isLoopbackHost,
  normalizeHostForBind,
  type ServerConfig,
} from "@the-40-thieves/obsidian-tc-shared";
import { toFetchResponse, toReqRes } from "fetch-to-node";
import { Hono } from "hono";
import type { FolderAcl } from "../acl";
import {
  buildProtectedResourceMetadata,
  isPrmConfigured,
  wwwAuthenticateChallenge,
} from "../auth/protected-resource";
import { createJwtVerifier, type TokenVerifier } from "../auth/verifier";
import type { Database } from "../db/types";
import type { FacadeMode } from "../mcp/facade";
import type { CallerContext, ToolRegistry } from "../mcp/registry";
import { createMcpServer } from "../mcp/server";
import type { VaultRegistry } from "../vault/registry";

type AuthConfig = ServerConfig["auth"];

export interface HttpAppOptions {
  name: string;
  version: string;
  registry: ToolRegistry;
  auth: AuthConfig;
  db: Database;
  acl: FolderAcl;
  vaultId: string;
  vaultRegistry?: VaultRegistry;
  /** Optional bearer-token verifier (W-AUTH seam). Defaults to an HS256 JWT verifier from `auth`. */
  verifier?: TokenVerifier;
  /** Tool-surface facade mode (THE-219), threaded to createMcpServer. */
  facadeMode?: FacadeMode;
  /** DNS-rebinding / cross-origin guard (THE-271). Defaults on when undefined. */
  enableDnsRebindingProtection?: boolean;
  /** Extra Host header values accepted beyond loopback (e.g. a reverse-proxy domain). */
  allowedHosts?: string[];
  /** Extra Origin header values accepted beyond the request's same origin. */
  allowedOrigins?: string[];
}

type AuthOutcome =
  | { ok: true; caller: string | null; scopes: Set<string>; vault?: string }
  | { ok: false; status: 401 | 500; reason: string };

function bearer(header: string | undefined): string | null {
  const m = header ? /^Bearer\s+(.+)$/i.exec(header) : null;
  return m?.[1] ?? null;
}

// The HTTP edge authenticates only: it verifies the token and derives caller +
// scopes. Authorization (scope/ACL/HITL) stays in registry.dispatch.
async function resolveAuth(
  header: string | undefined,
  auth: AuthConfig,
  verifier: TokenVerifier | null,
): Promise<AuthOutcome> {
  if (auth.mode === "none") {
    // Unauthenticated mode is only reachable on a loopback bind: ServerConfigSchema
    // fail-closes when HTTP is exposed on a non-loopback host with auth.mode "none".
    return { ok: true, caller: "http-local", scopes: new Set(["*"]) };
  }
  // auth.mode === "jwt" — the only other mode the config schema admits.
  const token = bearer(header);
  if (!token) return { ok: false, status: 401, reason: "missing bearer token" };
  if (!verifier) return { ok: false, status: 500, reason: "jwt mode misconfigured: no secret" };
  try {
    const id = await verifier.verify(token);
    return { ok: true, caller: id.caller, scopes: id.scopes, vault: id.vault };
  } catch {
    return { ok: false, status: 401, reason: "invalid or expired token" };
  }
}

/**
 * Build the Hono app exposing the MCP server over Streamable HTTP at POST /mcp.
 * Each request is stateless: the edge resolves auth, then a fresh MCP server +
 * transport are assembled with a CallerContext for that request and torn down
 * when the response closes. Node req/res are bridged from Hono's Fetch Request
 * via fetch-to-node, so the same app runs under Node or Bun.
 */
export function createHttpApp(opts: HttpAppOptions): Hono {
  const app = new Hono();
  // Token verifier seam (W-AUTH): default to HS256 JWT (jose) built from config; a custom
  // verifier (e.g. an OAuth 2.1 bearer/introspection verifier) may be injected via
  // opts.verifier without touching this transport. null in "none" mode or jwt-without-secret.
  const verifier: TokenVerifier | null =
    opts.verifier ??
    (opts.auth.mode === "jwt" && opts.auth.jwtSecret
      ? createJwtVerifier(opts.auth.jwtSecret, { maxAgeSeconds: opts.auth.tokenTtlSeconds })
      : null);

  // MCP 2025-11-25 / RFC 9728 Protected Resource Metadata (THE-278). Public, non-secret discovery,
  // served only when the operator configured a resource URI + authorization server(s). The document
  // and its URL derive from the configured resource origin, never the request Host (no injection).
  if (isPrmConfigured(opts.auth)) {
    const prm = buildProtectedResourceMetadata(opts.auth);
    app.get("/.well-known/oauth-protected-resource", (c) => c.json(prm));
    app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(prm));
  }

  app.post("/mcp", async (c) => {
    // DNS-rebinding / cross-origin guard (THE-271). A malicious web page POSTing to a loopback MCP
    // server is the canonical local-server attack: the config fail-closes a non-loopback bind under
    // auth 'none', but nothing stopped a browser drive-by against the loopback bind. Reject a Host
    // that is neither loopback nor operator-allowed, or an Origin (browsers always send one; a
    // server-to-server client does not) that is not the same origin or operator-allowed. Runs before
    // auth so a cross-origin request never reaches the pipeline.
    if (opts.enableDnsRebindingProtection !== false) {
      const rawHost = c.req.header("host") ?? "";
      const hostname = rawHost.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
      const hostAllowed =
        isLoopbackHost(hostname) ||
        hostname === "localhost" ||
        (opts.allowedHosts ?? []).includes(rawHost) ||
        (opts.allowedHosts ?? []).includes(hostname);
      if (!hostAllowed)
        return c.json(
          { jsonrpc: "2.0", error: { code: -32000, message: "host not allowed" }, id: null },
          403,
        );
      const origin = c.req.header("origin");
      if (origin) {
        const allowed = new Set(opts.allowedOrigins ?? []);
        allowed.add(`http://${rawHost}`);
        allowed.add(`https://${rawHost}`);
        if (!allowed.has(origin))
          return c.json(
            { jsonrpc: "2.0", error: { code: -32000, message: "origin not allowed" }, id: null },
            403,
          );
      }
    }
    const authz = await resolveAuth(c.req.header("authorization"), opts.auth, verifier);
    if (!authz.ok) {
      // RFC 9728 §5.1 challenge: on a 401, point a spec-compliant client at the PRM document so it
      // can discover the authorization server (THE-278). Only when PRM is configured.
      if (authz.status === 401 && isPrmConfigured(opts.auth))
        c.header("WWW-Authenticate", wwwAuthenticateChallenge(opts.auth));
      return c.json(
        { jsonrpc: "2.0", error: { code: -32001, message: authz.reason }, id: null },
        authz.status,
      );
    }

    let body: unknown;
    try {
      body = await c.req.raw.clone().json();
    } catch {
      return c.json(
        { jsonrpc: "2.0", error: { code: -32700, message: "parse error" }, id: null },
        400,
      );
    }

    const context = (): CallerContext => ({
      caller: authz.caller,
      authenticated: true,
      grantedScopes: authz.scopes,
      // Bind the caller to its token's vault (or the server default when the token carries no
      // `vault` claim). vaultBound makes dispatch reject a tool call naming a different vault
      // (THE-267), so an HTTP token cannot reach every configured vault via the `vault` argument.
      vaultId: authz.vault ?? opts.vaultId,
      vaultBound: true,
      db: opts.db,
      acl: opts.acl,
    });

    const server = createMcpServer({
      name: opts.name,
      version: opts.version,
      registry: opts.registry,
      context,
      vaultRegistry: opts.vaultRegistry,
      facadeMode: opts.facadeMode,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const { req, res } = toReqRes(c.req.raw);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return toFetchResponse(res);
  });

  // Stateless mode has no standalone SSE stream or server-side session to delete.
  app.on(["GET", "DELETE"], "/mcp", (c) =>
    c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32000, message: "method not allowed (stateless)" },
        id: null,
      },
      405,
    ),
  );

  return app;
}

export interface HttpHandle {
  port: number;
  close: () => Promise<void>;
}

/**
 * Serve the HTTP app on host:port via @hono/node-server (Node-first). Pass
 * port 0 for an ephemeral port; the resolved handle reports the actual port.
 * Bun-native serving is a follow-up.
 */
export function startHttp(
  opts: HttpAppOptions & { host: string; port: number },
): Promise<HttpHandle> {
  const app = createHttpApp(opts);
  return new Promise((resolve) => {
    const server = serve(
      { fetch: app.fetch, hostname: normalizeHostForBind(opts.host), port: opts.port },
      (info) => {
        resolve({
          port: info.port,
          close: () =>
            new Promise<void>((done) => {
              server.close(() => done());
            }),
        });
      },
    );
  });
}
