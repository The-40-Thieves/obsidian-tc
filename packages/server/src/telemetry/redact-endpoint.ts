// THE-1125 (security-scan follow-up, second round) — the ONE place `telemetry.endpoint` is turned
// into something safe to print or persist. Config validation (observability.schema.ts) already
// REFUSES userinfo in the endpoint, but a path segment can ALSO be a credential (a collector
// convention like `/ingest/<token>`), and CLI output routinely gets pasted into a support ticket
// or a public issue — so the default redacted form drops the path too. Every surface that shows
// the endpoint (`telemetry preview`/`status`, `doctor`, `server_health`, the boot notice) calls
// this one function rather than hand-rolling `new URL(...).host` per site — that duplication is
// exactly how one site would end up showing more than its siblings.
export function redactEndpoint(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "(unparseable)";
  }
}

/** Scheme + host + PATH — the one place a caller may show more than `redactEndpoint` does, and
 *  only on explicit request: `telemetry preview --show-path`. Never used by any surface that
 *  prints by default, and never by the send path's own logging (sender.ts always uses the plain
 *  `redactEndpoint` above). Query and fragment are still dropped unconditionally — those are
 *  addressed by nothing here (they were never validated against, unlike userinfo), so this
 *  function stays the narrowest widening that satisfies "let we see the routing path we
 *  configured" without reintroducing query-string leakage. */
export function redactEndpointWithPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "(unparseable)";
  }
}

/**
 * Scrub every occurrence of the raw `endpoint` string out of `message`, replacing it with
 * `redactEndpoint`'s scheme+host form. Defends against a transport error whose OWN message
 * embeds the full URL it tried to fetch — observed in practice on several `fetch`
 * implementations' `TypeError`/`AggregateError` text (Node/undici includes the request URL,
 * userinfo and query string included, in some error causes) — so `sendTelemetry` must not trust
 * `e.message` to already be safe just because the request itself never logs the endpoint. Also
 * catches the plain host and the bare `user:pw@host` userinfo spelling, in case the runtime's
 * message reflects a normalized form rather than the exact input string.
 */
export function scrubEndpointFromMessage(message: string, endpoint: string): string {
  if (endpoint.length === 0) return message;
  const redacted = redactEndpoint(endpoint);
  let out = message.split(endpoint).join(redacted);
  try {
    const u = new URL(endpoint);
    if (u.username.length > 0 || u.password.length > 0) {
      const userinfo = u.password.length > 0 ? `${u.username}:${u.password}@` : `${u.username}@`;
      out = out.split(`${userinfo}${u.host}`).join(u.host).split(userinfo).join("");
    }
  } catch {
    /* endpoint itself is unparseable; the whole-string replace above is the only defense left */
  }
  return out;
}

/**
 * THE-1125 (grok LOW-4): `scrubEndpointFromMessage` protects the endpoint, but a transport error
 * or an HTTP client library can ALSO echo request headers it sent — including
 * `Authorization: Bearer <token>` — back into its own error text (observed on several `fetch`
 * implementations' verbose error modes). `sender.ts` calls this INSTEAD of
 * `scrubEndpointFromMessage` alone whenever `authToken` is defined, so the bearer value can never
 * reach a log line or `telemetry_state.last_error`, the same guarantee the endpoint already has.
 * Strips both the bare token substring and any `Bearer <token>` spelling; case-sensitive (a bearer
 * token is itself case-sensitive, so a case-insensitive strip would both under- and over-match).
 */
export function scrubSecretsFromMessage(
  message: string,
  endpoint: string,
  authToken: string | undefined,
): string {
  let out = scrubEndpointFromMessage(message, endpoint);
  if (authToken !== undefined && authToken.length > 0) {
    out = out.split(`Bearer ${authToken}`).join("Bearer <redacted>");
    out = out.split(authToken).join("<redacted>");
  }
  return out;
}

/** Cap a message before it is logged or persisted as `lastError` — an unbounded transport error
 *  string (some stack-trace-shaped `AggregateError` messages run to several KB) is a storage and
 *  log-noise problem independent of the redaction above. Truncation happens AFTER scrubbing, so a
 *  cut can never re-expose a secret that redaction already removed — the same ordering
 *  dispatch-observability.ts's `captureArgs` uses for its own redact-then-cap secret scanner. */
export function capMessageLength(message: string, maxLen = 200): string {
  return message.length > maxLen ? `${message.slice(0, maxLen)}…[truncated]` : message;
}
