import { err } from "@the-40-thieves/obsidian-tc-shared";

/** A stage-boundary cooperative-cancellation check. Throws the same modelled
 *  `ObsidianTcError` the rest of dispatch throws (never a raw DOMException `AbortError`), so an
 *  abort surfaces through the normal catch/audit/metrics path below rather than as an unhandled
 *  rejection or an opaque `internal` error. A no-op when `signal` is absent or not yet aborted —
 *  every existing caller (no signal) sees no behavior change. */
export function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw err.aborted();
}
