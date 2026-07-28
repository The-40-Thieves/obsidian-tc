// THE-627 — which client software made the call.
//
// `event_log` could say a tool was called, by which caller, against which vault, but never by WHICH
// CLIENT: Claude Desktop, Cursor, Continue and a scripted HTTP caller were indistinguishable.
//
// Read from per-request `_meta`, NOT from the `initialize` handshake. That was this ticket's
// original scope and it is the wrong seam twice over:
//
//   1. MCP 2026-07-28 REMOVES the handshake entirely (SEP-2575). Protocol version, client info and
//      client capabilities travel in `_meta` on every request, with `server/discover` for
//      capabilities. Building against `getClientVersion()` means writing this twice.
//   2. `_meta` passthrough already exists in 2025-11-25, so reading it there works under BOTH specs
//      — this is how the migration cost is avoided rather than deferred.
//
// The per-request shape also fits better than the handshake would have. A stateless server has no
// protocol session to latch a per-connection value onto (`transports/http.ts` runs
// `sessionIdGenerator: undefined`), so "once per connection" was never a shape we actually had.
//
// Untrusted input, and treated as such — same discipline as `otel/propagation.ts`: strings only,
// bounded, dropped rather than truncated, absent is normal. These values reach a DB column, so an
// unbounded one is a storage problem, and a truncated version string is a WRONG version string.

/**
 * The reverse-DNS `_meta` key the 2026-07-28 spec assigns to client identity.
 *
 * THE-583: re-exported from the SDK rather than spelled out here. It was a hand-typed literal
 * written before the v2 SDK shipped; keeping a second copy of a wire constant is how a rename in
 * the spec becomes a silent no-op on our side — the key would simply stop matching and clientInfo
 * would read as absent, which is a legal state and therefore invisible.
 */
export { CLIENT_INFO_META_KEY } from "@modelcontextprotocol/server";

import { CLIENT_INFO_META_KEY } from "@modelcontextprotocol/server";

export interface ClientInfo {
  name: string;
  version?: string;
}

/**
 * Length ceiling for both fields. MCP client names and versions are short by nature
 * ("claude-desktop", "1.2.0"); 128 is far above anything legitimate while still bounding what a
 * hostile client can push into a row. Over-long values are DROPPED, never truncated — a truncated
 * version is indistinguishable from a real one and would be worse than no version at all.
 */
const MAX_LEN = 128;

const clean = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_LEN ? v : undefined;

/**
 * Lift `clientInfo` out of an MCP `_meta` bag.
 *
 * Returns `undefined` unless a usable `name` is present. `name` is the identity; a `version` with no
 * name identifies nothing, so that case is dropped whole rather than stored as a nameless version.
 *
 * Absence is the NORMAL case, not an error — most callers today send no `_meta` at all, and under
 * the current spec none send this key. Every absent/malformed path must therefore record NULL and
 * never a placeholder: a literal `"unknown"` in the column would be indistinguishable from a client
 * that genuinely calls itself unknown, which is the THE-613 defect shape (a failure encoded as a
 * valid domain value).
 */
export function extractClientInfo(meta: unknown): ClientInfo | undefined {
  if (meta === null || typeof meta !== "object") return undefined;
  const raw = (meta as Record<string, unknown>)[CLIENT_INFO_META_KEY];
  if (raw === null || typeof raw !== "object") return undefined;
  const src = raw as Record<string, unknown>;
  const name = clean(src.name);
  if (name === undefined) return undefined;
  const version = clean(src.version);
  return version === undefined ? { name } : { name, version };
}
