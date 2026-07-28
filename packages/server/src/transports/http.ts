import { readFileSync } from "node:fs";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { isLoopbackHost, type ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { Hono } from "hono";
import type { FolderAcl } from "../acl";
import { AuthRejection, type AuthRejectionReason } from "../auth/jwt";
import {
  buildProtectedResourceMetadata,
  isPrmConfigured,
  wwwAuthenticateChallenge,
} from "../auth/protected-resource";
import { createTokenVerifier, type TokenVerifier } from "../auth/verifier";
import type { Database } from "../db/types";
import type { FacadeMode } from "../mcp/facade";
import type { CallerContext, ToolRegistry } from "../mcp/registry";
import { createMcpServer } from "../mcp/server";
import type { MetricsRecorder } from "../metrics/registry";
import type { VaultRegistry } from "../vault/registry";
import { type ServerHandle, serveHono } from "./serve";

type AuthConfig = ServerConfig["auth"];

/** THE-520: operator-facing detail about a refused token. Never serialized to a client. */
export interface AuthRejectionDetail {
  reason: AuthRejectionReason;
  /** UNVERIFIED `sub` — the signature may be what failed. For log correlation only. */
  caller: string | null;
  expStillFuture: boolean;
}

/**
 * THE-520: emit a refused token to the operator — one stderr line plus an optional structured sink
 * and metric. Deliberately separate from the response path so widening what an operator sees can
 * never widen what a caller sees.
 */
function reportAuthRejection(d: AuthRejectionDetail, opts: HttpAppOptions): void {
  try {
    opts.metrics?.incAuthRejection(d.reason);
  } catch {
    /* metrics must never break the request path */
  }
  try {
    opts.onAuthRejected?.(d);
  } catch {
    /* diagnostics sink must never break the request path */
  }
  // `caller` is unverified; label it so a log reader never mistakes it for authenticated identity.
  const who = d.caller === null ? "" : ` caller(unverified)=${JSON.stringify(d.caller)}`;
  // The one line that would have made a 5-day outage a 5-minute one.
  const hint = d.expStillFuture
    ? " — token has NOT expired; it exceeded auth.tokenTtlSeconds. A long-lived token under a" +
      " short ttl is almost certainly a misconfiguration."
    : "";
  process.stderr.write(`auth: rejected reason=${d.reason}${who}${hint}\n`);
}

export interface HttpAppOptions {
  name: string;
  version: string;
  registry: ToolRegistry;
  auth: AuthConfig;
  db: Database;
  acl: FolderAcl;
  /** THE-520: optional structured sink for refused tokens (operator diagnostics). */
  onAuthRejected?: (detail: AuthRejectionDetail) => void;
  /** THE-520: optional Prometheus recorder for auth_rejections_total. */
  metrics?: MetricsRecorder;
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
  | {
      ok: false;
      status: 401 | 500;
      /** Client-facing message. Deliberately coarse — see `diagnosis` for the operator detail. */
      reason: string;
      /** THE-520: operator-only. Never rendered into the response. */
      diagnosis?: AuthRejectionDetail;
    };

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
  } catch (e) {
    // The message stays identical for every failure mode: an unauthenticated caller must not be
    // able to probe which check failed. The typed detail rides alongside for logs/metrics only.
    const diagnosis =
      e instanceof AuthRejection
        ? { reason: e.reason, caller: e.caller, expStillFuture: e.expStillFuture }
        : { reason: "malformed" as const, caller: null, expStillFuture: false };
    return { ok: false, status: 401, reason: "invalid or expired token", diagnosis };
  }
}

/**
 * Build the Hono app exposing the MCP server over Streamable HTTP at POST /mcp.
 * Each request is stateless: the edge resolves auth, then a fresh MCP server +
 * transport are assembled with a CallerContext for that request and torn down
 * when the response closes. Node req/res are bridged from Hono's Fetch Request
 * by createMcpHandler, which classifies the protocol era per request and serves both.
 */
export function createHttpApp(opts: HttpAppOptions): Hono {
  const app = new Hono();
  // Token verifier seam (W-AUTH): default to HS256 JWT (jose) built from config; a custom
  // verifier (e.g. an OAuth 2.1 bearer/introspection verifier) may be injected via
  // opts.verifier without touching this transport. null in "none" mode or jwt-without-secret.
  // THE-297: jwksFile loads ONCE at transport boot (file/inline only — no URL fetch); rotation
  // via multiple kid'd keys in the set, or a restart after replacing the file.
  const jwks =
    opts.auth.jwks ??
    (opts.auth.jwksFile
      ? (JSON.parse(readFileSync(opts.auth.jwksFile, "utf8")) as Record<string, unknown>)
      : undefined);
  // THE-456: bind the token audience. An explicit auth.audience wins; otherwise, when PRM is
  // configured, default it to the canonical `resource` URI (RFC 9728 / MCP 2025-11-25 require a
  // protected resource to accept only tokens whose aud is itself). Undefined keeps the legacy
  // behavior for local self-issued HS256. A JWKS (shared external issuer) with no effective
  // audience is the confused-deputy hole, so warn.
  const audience =
    opts.auth.audience ?? (isPrmConfigured(opts.auth) ? opts.auth.resource : undefined);
  if (jwks && audience === undefined) {
    process.stderr.write(
      "auth: JWKS configured without an audience — set auth.audience (or auth.resource) so tokens " +
        "minted by the same issuer for a different service are rejected (THE-456)\n",
    );
  }
  const verifier: TokenVerifier | null =
    opts.verifier ??
    (opts.auth.mode === "jwt" && (opts.auth.jwtSecret || jwks)
      ? createTokenVerifier({
          secret: opts.auth.jwtSecret,
          jwks,
          algorithms: opts.auth.algorithms,
          maxAgeSeconds: opts.auth.tokenTtlSeconds,
          audience,
          issuer: opts.auth.issuer,
        })
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
      if (authz.diagnosis) reportAuthRejection(authz.diagnosis, opts);
      // RFC 9728 §5.1 challenge: on a 401, point a spec-compliant client at the PRM document so it
      // can discover the authorization server (THE-278). Only when PRM is configured.
      if (authz.status === 401 && isPrmConfigured(opts.auth))
        c.header("WWW-Authenticate", wwwAuthenticateChallenge(opts.auth));
      return c.json(
        { jsonrpc: "2.0", error: { code: -32001, message: authz.reason }, id: null },
        authz.status,
      );
    }

    // Early malformed-JSON guard so a parse failure is a clean JSON-RPC -32700 rather than
    // whatever the handler would surface. The parsed value is not needed: createMcpHandler reads
    // the request itself.
    try {
      await c.req.raw.clone().json();
    } catch {
      return c.json(
        { jsonrpc: "2.0", error: { code: -32700, message: "parse error" }, id: null },
        400,
      );
    }

    // THE-514: signal is the per-request AbortSignal the MCP SDK hands each handler
    // (extra.signal in mcp/server.ts) — threaded through so a cancelled/disconnected HTTP call
    // stops runDispatch at the next stage boundary instead of running to completion unobserved.
    const context = (signal?: AbortSignal): CallerContext => ({
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
      signal,
    });

    // THE-583: createMcpHandler is the SDK's era-aware entry point, and using it is what makes
    // `server/discover` reachable at all. Hand-wiring Server + transport (what this did before)
    // never establishes a protocol era on a stateless connection, so every request fell back to
    // the frozen 2025 wire registry — which has no `server/discover` and answered -32601 no matter
    // what the client sent. The handler classifies each request itself and tells the factory which
    // era it is constructing for.
    //
    // `legacy: "stateless"` (the default, spelled out here because it is load-bearing) is exactly
    // the idiom this transport already used: each 2025-era request is served by a fresh instance
    // over a stateless transport. LiteLLM keeps working unchanged.
    //
    // Built per request rather than once, matching the previous per-request Server: the caller
    // context closes over THIS request's verified identity, and binding it to a long-lived handler
    // would leak one caller's authorization into another's request.
    const handler = createMcpHandler(
      (mcpCtx) =>
        createMcpServer({
          name: opts.name,
          version: opts.version,
          registry: opts.registry,
          context,
          vaultRegistry: opts.vaultRegistry,
          facadeMode: opts.facadeMode,
          // The SDK's own classification, not a header we re-interpret.
          era: mcpCtx.era,
        }),
      { legacy: "stateless" },
    );
    try {
      // Web-standard fetch in, Response out.
      return await handler.fetch(c.req.raw);
    } finally {
      void handler.close();
    }
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

export type HttpHandle = ServerHandle;

/**
 * Serve the HTTP app on host:port. Pass port 0 for an ephemeral port; the resolved handle
 * reports the actual port.
 *
 * The Bun-vs-Node choice lives in `serveHono` because it is a PROCESS-wide decision, not a
 * per-server one — see THE-659 there. THE-561 is why Bun wins under Bun: @hono/node-server's
 * Node-compat `http.Server` drops ~25% of requests that arrive on a REUSED keep-alive connection
 * with ECONNRESET, which a pooling client such as LiteLLM's httpx hits constantly. THE-583 removed
 * the fetch-to-node bridge this used to need: createMcpHandler is web-standard fetch in, Response
 * out, so the /mcp route no longer round-trips through Node req/res at all. Regression harnesses:
 * test/http-keepalive-reuse.bun.ts and bun-smoke/dual-http-servers.test.ts (both Bun-only).
 */
export function startHttp(
  opts: HttpAppOptions & { host: string; port: number },
): Promise<HttpHandle> {
  return serveHono(createHttpApp(opts), { host: opts.host, port: opts.port });
}
