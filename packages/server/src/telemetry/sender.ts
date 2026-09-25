// THE-1125 — POST one telemetry document, once, and never block or throw into a tool call.
//
// NOT routed through plane/egress-filter.ts's `assertSourcePathsAllowed`/port-guard machinery:
// that mechanism answers one question — "does this outbound request's `sourcePaths` name a
// vault-relative path under `egress.excludePaths`?" — for the generative/embedding/rerank legs
// that carry vault CONTENT. A telemetry document carries no vault content by construction
// (document.ts's `.strict()` schema has no field that could hold it, enforced by
// test/telemetry-document.test.ts), so there is no sourcePaths question to ask; wrapping this
// call in that guard would be security theatre over a request the guard was never designed to
// examine. Investigated: obsidian-tc has no generic "every outbound HTTP call needs an
// allowlisted host" wrapper beyond that content-egress guard (see egress-filter.ts/egress-guard.ts
// — both are exclusively about vault-relative sourcePaths). Telemetry's own safety net is
// therefore config-time: TelemetryConfigSchema refuses `enabled` without `endpoint`, and refuses a
// non-loopback `endpoint` that is not `https://` — see observability.schema.ts.
import type { Database } from "../db/types";
import type { TelemetryCollector } from "./collector";
import { buildTelemetryDocument, type TelemetryDocument } from "./document";
import { capMessageLength, redactEndpoint, scrubSecretsFromMessage } from "./redact-endpoint";
import { getOrCreateInstallId, recordSendResult } from "./state";

const SEND_TIMEOUT_MS = 10_000;

/** Security review (in-pool HIGH-A): a fixed, short, NEVER-derived-from-input code for the one
 *  failure mode that (with the tool-name/error-code allowlists in collector.ts) should now be
 *  unreachable in practice — `buildTelemetryDocument` throwing. Persisting the raw zod issue text
 *  here used to risk echoing the very key that caused the failure back into `lastError`, which a
 *  doctor/server_health caller then reads. */
const DOCUMENT_BUILD_FAILED_CODE = "document_build_failed";

/** Security review (in-pool LOW-G): `authTokenEnv` is CONFIGURED but the named env var is unset —
 *  refusing the send (rather than sending unauthenticated) is the fail-closed choice; an operator
 *  who configured a token clearly expects the collector to require one. */
const AUTH_TOKEN_ENV_MISSING_CODE = "auth_token_env_unset";

export interface TelemetrySendDeps {
  db: Database;
  collector: TelemetryCollector;
  endpoint: string;
  /** THE-1125 (security-review follow-up): name of an env var holding a bearer token, sent as
   *  `Authorization: Bearer <value>`. Resolved here (not by the caller) so the resolved VALUE
   *  never passes through any layer that might log its arguments — see
   *  `reference-never-log-argv-that-carries-secrets`'s lesson, applied a level up: the value is
   *  read straight from `process.env` into the one `fetch` call that uses it, never assigned to a
   *  variable this module's own error paths could stringify. When SET but the env var resolves to
   *  nothing, the send is refused rather than going out unauthenticated (LOW-G). */
  authTokenEnv?: string;
  serverVersion: string;
  facadeMode: "triad" | "domain" | "flat";
  now?: () => number;
  /** Test seam. Defaults to the runtime global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam / production wiring: where the one-line warning on failure goes. Defaults to
   *  stderr, matching plane-wiring.ts's `onError` convention for other best-effort background
   *  jobs. */
  onWarn?: (message: string) => void;
}

export interface TelemetrySendResult {
  ok: boolean;
  /** Absent only when building the document itself failed (see `sendTelemetry`'s own comment) —
   *  present on every ok:true and on every ordinary send failure. */
  document?: TelemetryDocument;
  /** Present only when `ok` is false. Never response bytes, never a raw thrown message — a fixed
   *  short code, an HTTP status line, or a transport error's `.message` with the endpoint and any
   *  bearer token scrubbed out. */
  error?: string;
}

/**
 * Build the current window's document, POST it once with a 10s timeout, and record the outcome.
 * Resets the collector's counters on a 2xx response OR a document-build failure (never on an
 * ordinary send failure — that must keep the window's counts so the NEXT tick's document is
 * cumulative rather than lossy). Never throws: every failure mode (network error, timeout,
 * non-2xx, a response the fetch implementation itself rejects) is caught, logged once via
 * `onWarn`, and returned as `{ ok: false }` — this is a scheduler job body, and the scheduler's own
 * contract (scheduler.ts) already guards `onError`, but telemetry must not rely on that as its
 * ONLY safety net (G2.4: observability must never break dispatch, applied here to "never break the
 * scheduler tick" instead).
 */
export async function sendTelemetry(deps: TelemetrySendDeps): Promise<TelemetrySendResult> {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const warn = deps.onWarn ?? ((m: string) => process.stderr.write(`[telemetry] ${m}\n`));

  // Redacted (scheme+host — never path/userinfo/query) in every log/persisted-error line below.
  // See redact-endpoint.ts's own header for why this is one shared helper rather than a per-site
  // `new URL(...)` read.
  const redacted = redactEndpoint(deps.endpoint);

  // Building the document can THROW (buildTelemetryDocument's own contract: a document that
  // cannot be built correctly must not be sent at all, never coerced into "something"). Caught
  // HERE, separately from the network try/catch below, so a malformed collector entry — now
  // UNREACHABLE in practice given collector.ts's own tool-name/error-code allowlists, but this
  // stays a real guard rather than an assumption — still cannot crash the scheduler tick
  // uncaught. Security review (in-pool HIGH-A): the collector is RESET here too (a poisoned entry
  // must not wedge every future tick into the same failure), and `lastError` gets the FIXED short
  // code above, never the raw zod issue text (which could itself echo whatever caused the
  // failure).
  let document: TelemetryDocument;
  try {
    const installId = getOrCreateInstallId(deps.db, now);
    const snap = deps.collector.snapshot(now);
    document = buildTelemetryDocument({
      installId,
      serverVersion: deps.serverVersion,
      os: process.platform,
      arch: process.arch,
      facadeMode: deps.facadeMode,
      clientNames: snap.clientNames,
      toolCalls: snap.toolCalls,
      errorCodes: snap.errorCodes,
      windowStart: snap.windowStart,
      windowEnd: snap.windowEnd,
    });
  } catch {
    warn(`send failed: ${DOCUMENT_BUILD_FAILED_CODE}`);
    deps.collector.reset(now);
    recordSendResult(deps.db, { at: now(), error: DOCUMENT_BUILD_FAILED_CODE });
    return { ok: false, error: DOCUMENT_BUILD_FAILED_CODE };
  }

  // Resolved straight into the one request that uses it — never assigned anywhere this module's
  // own error/log paths could stringify it (see the field's own comment above).
  const authToken = deps.authTokenEnv !== undefined ? process.env[deps.authTokenEnv] : undefined;
  if (deps.authTokenEnv !== undefined && (authToken === undefined || authToken.length === 0)) {
    // LOW-G: configured but unresolved — refuse rather than send unauthenticated. Counters are
    // KEPT (this is an ordinary send failure, not a document-build failure): the operator's
    // collector may well require the token, so an unauthenticated send would likely 401 anyway,
    // and either way this is a config problem to fix, not data to discard.
    warn(
      `send failed: bearer token env var ${deps.authTokenEnv} is not set — refusing to send unauthenticated`,
    );
    recordSendResult(deps.db, { at: now(), error: AUTH_TOKEN_ENV_MISSING_CODE });
    return { ok: false, document, error: AUTH_TOKEN_ENV_MISSING_CODE };
  }

  // Security review (grok HIGH-2): ONE AbortController bounds the ENTIRE send — not merely the
  // header wait `AbortSignal.timeout` alone covers, but also the body-cancel phase below. A
  // collector that answers with a status line and then streams an unbounded body would otherwise
  // hold this connection (and the scheduler's single-flight slot) open past the timeout.
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("telemetry send timed out")),
    SEND_TIMEOUT_MS,
  );
  try {
    const res = await fetchImpl(deps.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authToken !== undefined ? { authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify(document),
      signal: controller.signal,
      // Never auto-follow: a redirect can point anywhere, and following it would re-send the
      // bearer token (authToken above) and the document to a host the operator never configured
      // and never audited. `redirect: "manual"` (WHATWG fetch) makes the runtime return an
      // opaque, unfollowed response instead of chasing the Location header itself — treated as a
      // failure below, same as any other non-2xx, never a second request.
      redirect: "manual",
    });
    // Security review (grok HIGH-2): the response body is NEVER read — cancelled immediately,
    // before even checking `res.ok`, so a collector that answers 200 and then streams forever
    // cannot hold this connection open. `res.body` is null for a bodyless response (204, HEAD);
    // `cancel()` on an already-empty/consumed body is a safe no-op per the Streams spec. Any
    // failure to cancel is swallowed — it must never mask the real HTTP outcome computed below,
    // and the bounding AbortController above still guarantees this cannot hang past the timeout.
    try {
      await res.body?.cancel();
    } catch {
      /* best-effort release only */
    }
    // `res.type === "opaqueredirect"` is the manual-mode signal (status 0, no body/headers
    // readable) on a spec-compliant runtime; `res.status` in 300..399 covers a test double or a
    // runtime that surfaces the redirect status directly instead. Either way: never followed,
    // always a failure, and the Location header (which could itself leak into a log) is never read.
    const isRedirect = res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400);
    if (!res.ok || isRedirect) {
      const error = isRedirect
        ? `redirect refused from ${redacted} (telemetry never follows redirects)`
        : `HTTP ${res.status} from ${redacted}`;
      warn(`send failed: ${error}`);
      recordSendResult(deps.db, { at: now(), error });
      return { ok: false, document, error };
    }
    deps.collector.reset(now);
    recordSendResult(deps.db, { at: now() });
    return { ok: true, document };
  } catch (e) {
    // A transport error's `.message` (DNS failure, connection refused, the AbortController firing)
    // never carries response bytes or the document itself — but some `fetch` implementations
    // (Node/undici) embed the full request URL (userinfo/query included) AND, in verbose error
    // modes, request headers — which would include the bearer token — in a
    // TypeError/AggregateError's own text. `scrubSecretsFromMessage` strips BOTH the endpoint and
    // the bearer token value before this ever reaches a log line or `lastError`, then
    // length-capped (redaction always runs first, so a cut can never re-expose a secret redaction
    // already removed). Never retried in a loop: one attempt per scheduler tick, per the ticket.
    const rawMessage = e instanceof Error ? e.message : String(e);
    const error = capMessageLength(scrubSecretsFromMessage(rawMessage, deps.endpoint, authToken));
    warn(`send failed against ${redacted}: ${error}`);
    recordSendResult(deps.db, { at: now(), error });
    return { ok: false, document, error };
  } finally {
    clearTimeout(timer);
  }
}
