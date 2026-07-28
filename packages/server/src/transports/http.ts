import { readFileSync } from "node:fs";
import {
  createMcpHandler,
  localhostAllowedHostnames,
  validateHostHeader,
  validateOriginHeader,
} from "@modelcontextprotocol/server";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
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
import { getDefaultElicitTtlSeconds } from "../elicit";
import { createElicitCodec } from "../elicit-request-state";
import type { FacadeMode } from "../mcp/facade";
import type { CallerContext, ToolRegistry } from "../mcp/registry";
import { createMcpServer } from "../mcp/server";
import { MODERN_PROTOCOL_VERSION, serveTaskExtension } from "../mcp/tasks";
import type { MetricsRecorder } from "../metrics/registry";
import type { JobQueue } from "../scheduler/job-queue";
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
  /** THE-583: durable queue backing the Tasks extension; when absent, tasks/* are not served.
   *  Only caller-OWNED jobs are ever visible through it — everything this process enqueues for
   *  itself has a NULL owner and stays invisible (see mcp/tasks.ts). */
  jobQueue?: JobQueue;
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
/**
 * Rebuild a caller context from the request's pass-through `authInfo`.
 *
 * FAILS CLOSED. An absent `authInfo` means the request reached the handler without the Hono auth
 * gate having populated it, which cannot happen on any path that exists today — and if it ever
 * does, the safe answer is to refuse rather than mint a context. Defaulting here would produce
 * `authenticated: true` for a caller nobody verified, on the server's default vault.
 */
function contextFromAuthInfo(
  opts: HttpAppOptions,
  authInfo: { scopes?: string[]; extra?: Record<string, unknown> } | undefined,
): (signal?: AbortSignal) => CallerContext {
  return (signal?: AbortSignal): CallerContext => {
    if (authInfo === undefined) {
      throw new Error("unauthenticated request reached the MCP handler");
    }
    const extra = authInfo.extra as { caller?: string | null; vault?: string } | undefined;
    return {
      caller: extra?.caller ?? null,
      authenticated: true,
      grantedScopes: new Set(authInfo.scopes ?? []),
      // Bind the caller to its token's vault (or the server default when the token carries no
      // `vault` claim). vaultBound makes dispatch reject a tool call naming a different vault
      // (THE-267), so an HTTP token cannot reach every configured vault via the `vault` argument.
      vaultId: extra?.vault ?? opts.vaultId,
      vaultBound: true,
      db: opts.db,
      acl: opts.acl,
      signal,
    };
  };
}

export function createHttpApp(opts: HttpAppOptions): Hono {
  const app = new Hono();
  // THE-583: one codec per server, not per request — a state minted on one request is verified on
  // the NEXT one, so the key has to outlive both. Only available under `jwt` auth: without a
  // secret there is nothing to sign with, and an unauthenticated deployment has no caller identity
  // to bind a confirmation to anyway, so it keeps the 2025 token path.
  /**
   * THE-583: the MCP handler, created ONCE for the app rather than per request.
   *
   * It used to be per request, and the reason was sound: the caller context closed over THIS
   * request's verified identity, so a long-lived handler would have leaked one caller's
   * authorization into another's. That constraint is what made a long-lived
   * `subscriptions/listen` stream impossible — the handler serving it was closed the instant the
   * request that created it returned.
   *
   * The isolation is preserved by a different mechanism, not dropped. `createMcpHandler` invokes
   * its factory once per SERVING UNIT — one HTTP request — and hands it that request's
   * `authInfo`, which the SDK treats as strictly pass-through (it never reads headers or verifies
   * anything itself). So the caller context is still built per request from this request's
   * identity; it simply arrives as an argument instead of a closure. Auth itself is unchanged and
   * still runs in Hono, ahead of this.
   *
   * Asserted by test/http-caller-isolation.test.ts, which drives two different tokens through the
   * SAME handler and fails if either sees the other's scopes or vault.
   */
  const handler = createMcpHandler(
    (mcpCtx) =>
      createMcpServer({
        name: opts.name,
        version: opts.version,
        registry: opts.registry,
        context: contextFromAuthInfo(opts, mcpCtx.authInfo),
        vaultRegistry: opts.vaultRegistry,
        facadeMode: opts.facadeMode,
        // The SDK's own classification, not a header we re-interpret.
        era: mcpCtx.era,
        elicitCodec,
        jobQueue: opts.jobQueue,
      }),
    { legacy: "stateless" },
  );

  const elicitCodec = opts.auth.jwtSecret
    ? createElicitCodec(opts.auth.jwtSecret, getDefaultElicitTtlSeconds())
    : undefined;
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
      // THE-583: validation is the SDK's (`validateHostHeader` / `validateOriginHeader`), which
      // parses IPv6 brackets and ports properly rather than by regex.
      //
      // The allowlist is normalized first, and that is NOT incidental. The SDK matches on the
      // HOSTNAME; our config schema documents `allowedHosts` as "Host header VALUES", so an
      // operator may legitimately have written `example.com:8765`. Passing that straight to the
      // SDK matches nothing — every request 403s, which is an outage rather than a warning.
      // Feeding both forms keeps the documented contract while gaining the better parser.
      const hostnameOf = (v: string) => v.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
      const bothForms = (vs: readonly string[]) => vs.flatMap((v) => [v, hostnameOf(v)]);

      const allowedHostnames = [
        ...localhostAllowedHostnames(),
        ...bothForms(opts.allowedHosts ?? []),
      ];
      if (!validateHostHeader(rawHost, allowedHostnames).ok)
        return c.json(
          { jsonrpc: "2.0", error: { code: -32000, message: "host not allowed" }, id: null },
          403,
        );

      const origin = c.req.header("origin");
      if (origin) {
        // Same-origin stays allowed: the request's own Host is the origin a browser would send.
        const allowedOriginHosts = [
          hostnameOf(rawHost),
          ...bothForms(opts.allowedOrigins ?? []).map((o) =>
            hostnameOf(o.replace(/^\w+:\/\//, "")),
          ),
        ];
        if (!validateOriginHeader(origin, allowedOriginHosts).ok)
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
    let body: unknown;
    try {
      body = await c.req.raw.clone().json();
    } catch {
      return c.json(
        { jsonrpc: "2.0", error: { code: -32700, message: "parse error" }, id: null },
        400,
      );
    }

    // THE-583: serve the Tasks EXTENSION here, BEFORE delegating.
    //
    // `createMcpHandler` validates an inbound method against the spec registry and answers -32601
    // for anything it does not recognise — extension methods included. Measured: a `tasks/get`
    // handler registered on the server is never consulted, even with era=modern, because the
    // handler rejects the method first. (A raw transport DOES route it, which is what made the
    // difference easy to miss.) So an extension cannot be served through the handler; it has to be
    // answered in front of it.
    //
    // Everything the extension needs is already established at this point: auth has run, so
    // `authz` names the caller and vault the ownership check uses.
    if (opts.jobQueue && c.req.header("mcp-protocol-version") === MODERN_PROTOCOL_VERSION) {
      const taskResponse = await serveTaskExtension(body, opts.jobQueue, {
        vaultId: authz.vault ?? opts.vaultId,
        caller: authz.caller,
      });
      if (taskResponse !== undefined) return c.json(taskResponse);
    }
    // Web-standard fetch in, Response out. `authInfo` is how this request's verified identity
    // reaches the factory — strictly pass-through, so the handler never re-derives or re-checks it.
    // NOT closed here any more: the handler is the app's, and closing it per request is what made a
    // long-lived `subscriptions/listen` stream impossible.
    return await handler.fetch(c.req.raw, {
      authInfo: {
        token: bearer(c.req.header("authorization")) ?? "",
        clientId: authz.caller ?? "",
        scopes: [...authz.scopes],
        extra: { caller: authz.caller, vault: authz.vault },
      },
    });
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
