import { readFileSync } from "node:fs";
import {
  createMcpHandler,
  localhostAllowedHostnames,
  type ServerNotifier,
  validateHostHeader,
  validateOriginHeader,
} from "@modelcontextprotocol/server";
import type {
  PersonasConfig,
  ServerConfig,
  ToolVisibilityConfig,
} from "@the-40-thieves/obsidian-tc-shared";
import { Hono } from "hono";
import type { FolderAcl } from "../acl";
import { AuthRejection, type AuthRejectionReason } from "../auth/jwt";
import { resolvePersona } from "../auth/persona";
import {
  buildProtectedResourceMetadata,
  isPrmConfigured,
  wwwAuthenticateChallenge,
} from "../auth/protected-resource";
import { createTokenVerifier, type TokenVerifier } from "../auth/verifier";
import type { Database } from "../db/types";
import { getDefaultElicitTtlSeconds } from "../elicit";
import { createElicitCodec } from "../elicit-request-state";
import type { AdvisoryBus } from "../mcp/advisories";
import { serveAdvisorySubscription, subscribesToAdvisories } from "../mcp/advisories";
import type { FacadeMode } from "../mcp/facade";
import type { CallerContext, ToolRegistry } from "../mcp/registry";
import { createMcpServer } from "../mcp/server";
import {
  MODERN_PROTOCOL_VERSION,
  serveTaskExtension,
  serveTaskSubscription,
  subscribesToTasks,
} from "../mcp/tasks";
import type { VisibilityCaller } from "../mcp/visibility";
import type { MetricsRecorder } from "../metrics/registry";
import type { JobQueue } from "../scheduler/job-queue";
import type { VaultRegistry } from "../vault/registry";
import { activeSessionFor, DEFAULT_TRACE_FOLDER, openImplicitSession } from "../workspace/sessions";
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
  // Names the misconfiguration directly (see design note for the incident this call site guards
  // against) rather than leaving an operator to infer it from a bare rejection reason.
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
  /** THE-726: server-opened session policy. Absent -> resolve-only, the #691/#692 behaviour. */
  sessions?: { autoOpen: boolean; windowSeconds: number };
  /** Per-vault trace folder, so a server-opened session's `trace_path` matches where
   *  `get_session_traces` looks. Absent -> DEFAULT_TRACE_FOLDER, the same fallback m5 uses. */
  traceFolderFor?: (vaultId: string) => string;
  /** Optional bearer-token verifier (W-AUTH seam). Defaults to an HS256 JWT verifier from `auth`. */
  verifier?: TokenVerifier;
  /** THE-583: durable queue backing the Tasks extension; when absent, tasks/* are not served.
   *  Only caller-OWNED jobs are ever visible through it — everything this process enqueues for
   *  itself has a NULL owner and stays invisible (see mcp/tasks.ts). */
  jobQueue?: JobQueue;
  /** THE-634: publish side of the advisory push extension; when absent, advisory subscriptions are
   *  not served (the caller falls through to the SDK handler, which acks with an empty filter and
   *  delivers nothing — see mcp/advisories.ts). Absent whenever `experiential.proactive.enabled`
   *  is false, so the wire surface itself — not just the scheduler tick — is unchanged by the flag. */
  advisoryBus?: AdvisoryBus;
  /** Tool-surface facade mode (THE-219), threaded to createMcpServer. */
  facadeMode?: FacadeMode;
  /** DNS-rebinding / cross-origin guard (THE-271). Defaults on when undefined. */
  enableDnsRebindingProtection?: boolean;
  /** Extra Host header values accepted beyond loopback (e.g. a reverse-proxy domain). */
  allowedHosts?: string[];
  /** Extra Origin header values accepted beyond the request's same origin. */
  allowedOrigins?: string[];
  /** THE-647 item 2: named persona bundles a JWT `persona` claim resolves to (auth/persona.ts).
   *  Absent (the default) means no persona claim can ever resolve — a token carrying one is
   *  refused. */
  personas?: PersonasConfig;
}

type AuthOutcome =
  | {
      ok: true;
      caller: string | null;
      scopes: Set<string>;
      vault?: string;
      /** THE-647 item 2: set only when the token's `persona` claim resolved. `scopes`/`vault`
       *  above are ALREADY the persona's resolved values by this point — never the token's raw
       *  ones — so every downstream reader can keep using them unconditionally. */
      persona?: string;
      toolVisibility?: ToolVisibilityConfig;
    }
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
  personas: PersonasConfig | undefined,
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
    // THE-647 item 2: a `persona` claim resolves to an effective scope/vault/toolVisibility
    // bundle that REPLACES the token's own — never a union with it. FAILS CLOSED: an unknown
    // persona name, or a `vault` claim outside that persona's `vaults`, is refused entirely
    // rather than falling through to the token's raw (wider) grant.
    if (id.persona !== undefined) {
      const resolved = resolvePersona(id.persona, id.vault, personas);
      if (!resolved.ok) {
        return {
          ok: false,
          status: 401,
          reason: "invalid or expired token",
          diagnosis: { reason: "persona_denied", caller: id.caller, expStillFuture: false },
        };
      }
      return {
        ok: true,
        caller: id.caller,
        scopes: resolved.resolution.scopes,
        vault: resolved.resolution.vaultId,
        persona: resolved.resolution.persona,
        toolVisibility: resolved.resolution.toolVisibility,
      };
    }
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
type HttpAuthInfo = { scopes?: string[]; extra?: Record<string, unknown> } | undefined;

/**
 * THE-937 round 3: PURE — reads `authInfo` and `opts.acl` only, no DB, no session. Returns
 * exactly what `McpServerOptions.visibility` needs. A prior fix called the FULL `context` factory
 * (below) at server construction to build that value, and `context` is NOT pure on HTTP: it
 * resolves, and with `sessions.autoOpen` on OPENS, a workspace session as a side effect — so a
 * bare `initialize` or a bare triad `tools/list` opened a session before any dispatch happened.
 * `contextFromAuthInfo` calls this and layers vault/session/DB resolution on top, so the two
 * cannot drift apart.
 */
function visibilityFromAuthInfo(opts: HttpAppOptions, authInfo: HttpAuthInfo): VisibilityCaller {
  if (authInfo === undefined) {
    throw new Error("unauthenticated request reached the MCP handler");
  }
  const extra = authInfo.extra as { toolVisibility?: ToolVisibilityConfig } | undefined;
  return {
    grantedScopes: new Set(authInfo.scopes ?? []),
    readOnly: opts.acl?.readOnly,
    ...(extra?.toolVisibility !== undefined ? { toolVisibility: extra.toolVisibility } : {}),
  };
}

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
  authInfo: HttpAuthInfo,
): (signal?: AbortSignal) => CallerContext {
  return (signal?: AbortSignal): CallerContext => {
    if (authInfo === undefined) {
      throw new Error("unauthenticated request reached the MCP handler");
    }
    const visibility = visibilityFromAuthInfo(opts, authInfo);
    const extra = authInfo.extra as
      | { caller?: string | null; vault?: string; persona?: string }
      | undefined;
    return {
      caller: extra?.caller ?? null,
      authenticated: true,
      // VisibilityCaller.grantedScopes is typed Iterable<string> (visibility.ts's own
      // grantsAll/grantsScope contract); CallerContext wants the concrete Set. Cheap: it's a
      // freshly-built Set already, this just re-asserts the concrete type.
      grantedScopes: new Set(visibility.grantedScopes),
      // THE-647 item 2: `authInfo.scopes` above ALREADY carries the persona's resolved scopes —
      // resolveAuth replaced them, never unioned — so this context needs no persona-specific
      // scope handling. `persona`/`toolVisibility` ride along for tracing and the visibility
      // composition (mcp/visibility.ts); both undefined for every non-persona caller.
      ...(extra?.persona !== undefined ? { persona: extra.persona } : {}),
      ...(visibility.toolVisibility !== undefined
        ? { toolVisibility: visibility.toolVisibility }
        : {}),
      // Bind the caller to its token's vault (or the server default when the token carries no
      // `vault` claim). vaultBound makes dispatch reject a tool call naming a different vault
      // (THE-267), so an HTTP token cannot reach every configured vault via the `vault` argument.
      vaultId: extra?.vault ?? opts.vaultId,
      vaultBound: true,
      db: opts.db,
      acl: opts.acl,
      signal,
      // THE-726: attach the caller's open session, resolved DURABLY from SQLite (a single indexed
      // row, idx_workspace_sessions_principal, partial on ended_at IS NULL) rather than cached, so
      // it holds up across restarts and concurrent HTTP clients. Keyed on the AUTHENTICATED
      // principal — `activeSessionFor` refuses NULL/empty by construction. See design note for why
      // this is a transport gap rather than a client-adoption gap.
      //
      // The vault match is REQUIRED: HTTP's context is `vaultBound: true` (THE-267), so the bound
      // vault is the only one this context can act on, and attaching a session opened against a
      // different vault would point its JSONL trace at a vault this request cannot touch.
      //
      // THE-726 slice 3: when `sessions.autoOpen` is on and the principal has no open session, the
      // server opens one rather than waiting for a client to — off by default (SessionsConfigSchema),
      // in which case this is byte-identical to the resolve-only behaviour above.
      ...(() => {
        const bound = extra?.vault ?? opts.vaultId;
        const principal = extra?.caller ?? null;
        const active = activeSessionFor(opts.db, principal);
        if (active) return active.vaultId === bound ? { sessionId: active.sessionId } : {};
        // `activeSessionFor` already refuses a NULL/empty principal; re-checking here keeps the
        // OPEN path from depending on that, because writing a row for an unidentifiable principal
        // would create exactly the shared bucket the resolver refuses to read from.
        if (!opts.sessions?.autoOpen || typeof principal !== "string" || principal.length === 0)
          return {};
        const opened = openImplicitSession(opts.db, {
          principal,
          vaultId: bound,
          traceFolder: opts.traceFolderFor?.(bound) ?? DEFAULT_TRACE_FOLDER,
          now: Date.now(),
        });
        return { sessionId: opened.sessionId };
      })(),
    };
  };
}

/**
 * The app plus the MCP handler backing it.
 *
 * The handler is returned rather than hidden because two things now depend on outliving a request:
 * its `notify` facade (the publish side of `subscriptions/listen`) and its `close()` (which was
 * previously called per request and must now happen at shutdown).
 */
export interface HttpApp {
  app: Hono;
  /** Publish-side facade over the `subscriptions/listen` bus. No-op when no stream is open. */
  notify: ServerNotifier;
  /** Aborts in-flight modern exchanges and closes their per-request instances. */
  close: () => Promise<void>;
}

export function createHttpApp(opts: HttpAppOptions): HttpApp {
  const app = new Hono();
  // THE-583: one codec per server, not per request — a state minted on one request is verified on
  // the NEXT one, so the key has to outlive both. Only available under `jwt` auth: without a
  // secret there is nothing to sign with, and an unauthenticated deployment has no caller identity
  // to bind a confirmation to anyway, so it keeps the 2025 token path.
  /**
   * THE-583: the MCP handler, created ONCE for the app rather than per request.
   *
   * Caller isolation is preserved by a different mechanism than a per-request handler:
   * `createMcpHandler` invokes its factory once per SERVING UNIT — one HTTP request — and hands it
   * that request's `authInfo`, which the SDK treats as strictly pass-through. The caller context is
   * still built per request from this request's identity; it arrives as an argument instead of a
   * closure. Auth itself is unchanged and still runs in Hono, ahead of this.
   *
   * Asserted by test/http-caller-isolation.test.ts, which drives two different tokens through the
   * SAME handler and fails if either sees the other's scopes or vault. See design note for why this
   * used to require a per-request handler.
   */
  const handler = createMcpHandler(
    (mcpCtx) =>
      createMcpServer({
        name: opts.name,
        version: opts.version,
        registry: opts.registry,
        context: contextFromAuthInfo(opts, mcpCtx.authInfo),
        // THE-937 round 3: the PURE half of the same authInfo — see visibilityFromAuthInfo's
        // doc comment for why this must not be `contextFromAuthInfo`'s own resolver.
        visibility: visibilityFromAuthInfo(opts, mcpCtx.authInfo),
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
          jwksUri: opts.auth.jwksUri,
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
      // parses IPv6 brackets and ports properly rather than by regex. The allowlist is normalized
      // first, and that is NOT incidental: the SDK matches on the HOSTNAME, while our config schema
      // documents `allowedHosts` as "Host header VALUES" (which may include a port). Feeding both
      // forms keeps the documented contract while gaining the better parser — omitting either
      // direction turns a legitimate operator entry into a 403 outage.
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
    const authz = await resolveAuth(
      c.req.header("authorization"),
      opts.auth,
      verifier,
      opts.personas,
    );
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

    // THE-583: serve the Tasks EXTENSION here, BEFORE delegating. `createMcpHandler` validates an
    // inbound method against the spec registry and answers -32601 for anything it does not
    // recognise, extension methods included — so an extension cannot be served through the handler
    // and has to be answered in front of it. See design note. Everything it needs is already
    // established at this point: auth has run, so `authz` names the caller and vault the ownership
    // check uses.
    if (opts.jobQueue && c.req.header("mcp-protocol-version") === MODERN_PROTOCOL_VERSION) {
      const taskResponse = await serveTaskExtension(body, opts.jobQueue, {
        vaultId: authz.vault ?? opts.vaultId,
        caller: authz.caller,
      });
      if (taskResponse !== undefined) return c.json(taskResponse);
      // THE-583: the extension's own `subscriptions/listen` stream. Served here for the same reason
      // as the methods above — the SDK's SubscriptionFilter is a strict four-key object and its
      // ServerEvent union is closed over the same four, so neither the opt-in nor the event is
      // expressible through it. Only intercepted when the client actually asked for task
      // notifications; every other listen request goes to the SDK untouched.
      if (subscribesToTasks(body)) {
        return serveTaskSubscription(
          body,
          opts.jobQueue,
          { vaultId: authz.vault ?? opts.vaultId, caller: authz.caller },
          c.req.raw.signal,
        );
      }
    }
    // THE-634: the advisory push extension, same seam and same reason as the Tasks extension just
    // above — its subscription key and event are not expressible through the SDK's own
    // SubscriptionFilter/ServerEvent union either. Only intercepted when a bus is wired (i.e.
    // experiential.proactive.enabled) AND the client actually asked for advisory notifications.
    if (
      opts.advisoryBus &&
      c.req.header("mcp-protocol-version") === MODERN_PROTOCOL_VERSION &&
      subscribesToAdvisories(body)
    ) {
      return serveAdvisorySubscription(
        body,
        opts.advisoryBus,
        { vaultId: authz.vault ?? opts.vaultId, caller: authz.caller },
        c.req.raw.signal,
      );
    }
    // Web-standard fetch in, Response out. `authInfo` is how this request's verified identity
    // reaches the factory — strictly pass-through, so the handler never re-derives or re-checks it.
    // NOT closed here any more: the handler is the app's, and closing it per request is what made a
    // long-lived `subscriptions/listen` stream impossible.
    return await handler.fetch(c.req.raw, {
      // The body we already parsed above (for the Tasks extension checks). Without this the SDK
      // parses the same bytes a SECOND time on every request — `createMcpHandler` only parses when
      // `parsedBody` is undefined. The clone stays: the SDK is handed the untouched request, and
      // this is purely about not re-doing the JSON work.
      ...(body !== undefined ? { parsedBody: body } : {}),
      authInfo: {
        token: bearer(c.req.header("authorization")) ?? "",
        clientId: authz.caller ?? "",
        scopes: [...authz.scopes],
        extra: {
          caller: authz.caller,
          vault: authz.vault,
          persona: authz.persona,
          toolVisibility: authz.toolVisibility,
        },
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

  // The handler is the APP's now. Closing it is a shutdown concern, and `notify` is how a change
  // detected outside any request (the vault watcher) reaches an open subscription stream.
  return { app, notify: handler.notify, close: () => handler.close() };
}

export type HttpHandle = ServerHandle & {
  /**
   * THE-583: publish a change event to every open `subscriptions/listen` stream that opted in.
   *
   * Exposed on the handle because the events originate OUTSIDE the request path — the vault watcher
   * sees a note change, and no request is in flight to carry the notification.
   */
  notify: ServerNotifier;
};

/**
 * Serve the HTTP app on host:port. Pass port 0 for an ephemeral port; the resolved handle
 * reports the actual port.
 *
 * The Bun-vs-Node choice lives in `serveHono` because it is a PROCESS-wide decision, not a
 * per-server one — see THE-659 there. THE-561 is why Bun wins under Bun: @hono/node-server's
 * Node-compat `http.Server` drops requests on a REUSED keep-alive connection with ECONNRESET,
 * which a pooling client such as LiteLLM's httpx hits constantly. THE-583 removed the
 * fetch-to-node bridge this used to need: createMcpHandler is web-standard fetch in, Response out.
 * Regression harnesses (Bun-only, bun-smoke/): bun-smoke/http-keepalive-reuse.test.ts and
 * bun-smoke/dual-http-servers.test.ts — both must actually be reachable from `bun test bun-smoke`;
 * see design note for the THE-730 gap where one of them was not.
 */
export function startHttp(
  opts: HttpAppOptions & { host: string; port: number },
): Promise<HttpHandle> {
  const { app, notify, close } = createHttpApp(opts);
  return serveHono(app, { host: opts.host, port: opts.port }).then((handle) => ({
    ...handle,
    notify,
    // Close the MCP handler BEFORE the socket: it aborts in-flight modern exchanges, and doing it
    // after would leave a `subscriptions/listen` stream holding a connection the server is trying
    // to shut down. Previously the handler was closed per request, so nothing owned this.
    close: async () => {
      await close();
      await handle.close();
    },
  }));
}
