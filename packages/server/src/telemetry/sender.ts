// THE-1125 — POST one telemetry document, once, and never block or throw into a tool call.
//
// NOT routed through plane/egress-filter.ts's `assertSourcePathsAllowed`/port-guard machinery:
// that mechanism answers one question — "does this outbound request's `sourcePaths` name a
// vault-relative path under `egress.excludePaths`?" — for the generative/embedding/rerank legs
// that carry vault CONTENT. A telemetry document carries no vault content by construction
// (document.ts's `.strict()` schema has no field that could hold it, enforced by
// telemetry-forbidden-fields.test.ts), so there is no sourcePaths question to ask; wrapping this
// call in that guard would be security theatre over a request the guard was never designed to
// examine. Investigated: obsidian-tc has no generic "every outbound HTTP call needs an
// allowlisted host" wrapper beyond that content-egress guard (see egress-filter.ts/egress-guard.ts
// — both are exclusively about vault-relative sourcePaths). Telemetry's own safety net is
// therefore config-time: TelemetryConfigSchema refuses `enabled` without `endpoint`, and refuses a
// non-loopback `endpoint` that is not `https://` — see observability.schema.ts.
import type { Database } from "../db/types";
import type { TelemetryCollector } from "./collector";
import { buildTelemetryDocument, type TelemetryDocument } from "./document";
import { capMessageLength, redactEndpoint, scrubEndpointFromMessage } from "./redact-endpoint";
import { getOrCreateInstallId, recordSendResult } from "./state";

const SEND_TIMEOUT_MS = 10_000;

export interface TelemetrySendDeps {
  db: Database;
  collector: TelemetryCollector;
  endpoint: string;
  /** THE-1125 (security-review follow-up): name of an env var holding a bearer token, sent as
   *  `Authorization: Bearer <value>`. Resolved here (not by the caller) so the resolved VALUE
   *  never passes through any layer that might log its arguments — see
   *  `reference-never-log-argv-that-carries-secrets`'s lesson, applied a level up: the value is
   *  read straight from `process.env` into the one `fetch` call that uses it, never assigned to a
   *  variable this module's own error paths could stringify. */
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
  /** Present only when `ok` is false. Never response bytes — an HTTP status line or a transport
   *  error's own `.message`, nothing the collector fed in. */
  error?: string;
}

/**
 * Build the current window's document, POST it once with a 10s timeout, and record the outcome.
 * Resets the collector's counters ONLY on a 2xx response — a failed send keeps the window's counts
 * so the NEXT tick's document is cumulative rather than lossy. Never throws: every failure mode
 * (network error, timeout, non-2xx, a response the fetch implementation itself rejects) is caught,
 * logged once via `onWarn`, and returned as `{ ok: false }` — this is a scheduler job body, and the
 * scheduler's own contract (scheduler.ts) already guards `onError`, but telemetry must not rely on
 * that as its ONLY safety net (G2.4: observability must never break dispatch, applied here to
 * "never break the scheduler tick" instead).
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
  // HERE, separately from the network try/catch below, so a malformed collector entry (never
  // expected in practice — tool names/error codes are both bounded, internal vocabularies) still
  // cannot crash the scheduler tick uncaught, matching this function's own "never throws" promise.
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
  } catch (e) {
    const error = capMessageLength(e instanceof Error ? e.message : String(e));
    warn(`document build failed, nothing sent: ${error}`);
    recordSendResult(deps.db, { at: now(), error });
    return { ok: false, error };
  }

  // Resolved straight into the one request that uses it — never assigned anywhere this module's
  // own error/log paths could stringify it (see the field's own comment above).
  const authToken = deps.authTokenEnv !== undefined ? process.env[deps.authTokenEnv] : undefined;

  try {
    const res = await fetchImpl(deps.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authToken !== undefined ? { authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify(document),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      // Never auto-follow: a redirect can point anywhere, and following it would re-send the
      // bearer token (authToken above) and the document to a host the operator never configured
      // and never audited. `redirect: "manual"` (WHATWG fetch) makes the runtime return an
      // opaque, unfollowed response instead of chasing the Location header itself — treated as a
      // failure below, same as any other non-2xx, never a second request.
      redirect: "manual",
    });
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
    // A transport error's `.message` (DNS failure, connection refused, the AbortSignal.timeout
    // firing) never carries response bytes or the document itself — but some `fetch`
    // implementations (Node/undici) embed the full request URL, userinfo and query string
    // included, in a TypeError/AggregateError's own text. Scrubbed to the SAME redacted form
    // before logging or persisting as `lastError`, then length-capped (redaction always runs
    // first, so a cut can never re-expose a secret redaction already removed). Never retried in a
    // loop: one attempt per scheduler tick, per the ticket.
    const rawMessage = e instanceof Error ? e.message : String(e);
    const error = capMessageLength(scrubEndpointFromMessage(rawMessage, deps.endpoint));
    warn(`send failed against ${redacted}: ${error}`);
    recordSendResult(deps.db, { at: now(), error });
    return { ok: false, document, error };
  }
}
