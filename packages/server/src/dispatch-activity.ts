// Process-local dispatch activity bookkeeping, shared by the dispatch attach point
// (mcp/registry.ts's `ToolRegistry.dispatch`, which marks) and the session sweepers
// (workspace/sessions.ts, which READ the marks to never close a session mid-call). It lives at
// the src root because the two sit in sibling subsystems that must not import each other
// (no-mcp-imports-higher): workspace/rerun.ts drives the registry, so workspace is the higher
// layer, and these five functions are the whole interface dispatch needs from it.

/**
 * THE-1108 fix round (Codex P1-2): process-local, best-effort registry of "does any call have this
 * session attached RIGHT NOW" — the one thing a purely age-based close needs to keep the promise
 * both sweeps in workspace/sessions.ts (and `maxExplicitLifetimeSeconds`'s own schema description)
 * make: a session with a request in flight is never closed out from under it.
 *
 * `markInFlight` is called from the single shared dispatch attach point (`ToolRegistry.dispatch`,
 * mcp/registry.ts) in a try/finally, so a throw mid-handler still releases. Reference-counted, not
 * a boolean: two concurrent calls sharing one sessionId must not let the first call's release
 * un-mark the second's still-running one. The returned release function is itself idempotent — a
 * duplicate call cannot under-count.
 *
 * Not persisted, same caveat as workspace/sessions.ts's `ActiveSessionTracker`: a crash mid-call
 * loses the count, so a session genuinely in flight at the moment of a crash is fair game for the
 * sweep after a restart — no worse than this function not existing at all.
 */
const inFlightCounts = new Map<string, number>();

/** Mark `sessionId` as having one more call attached. Returns a release function — call it exactly
 *  once when that call finishes, success or throw; a duplicate call is a no-op. */
export function markInFlight(sessionId: string): () => void {
  inFlightCounts.set(sessionId, (inFlightCounts.get(sessionId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (inFlightCounts.get(sessionId) ?? 1) - 1;
    if (remaining <= 0) inFlightCounts.delete(sessionId);
    else inFlightCounts.set(sessionId, remaining);
  };
}

/**
 * GH #995 follow-up: process-wide "is any dispatch in flight, or did one just finish" signal for
 * the boot/promotion reconcile's idle-paced embed (search/indexing/embed-pace.ts's `waitForIdle`).
 *
 * Deliberately NOT derived from `inFlightCounts` above: that map is only populated `if
 * (ctx.sessionId !== undefined)` (mcp/registry.ts's `dispatch()`), and `sessionId` is absent on
 * the common stdio call with no explicit `start_session` — the boot reconcile would see an
 * empty map and never pace at all against the overwhelming majority of real traffic. This is a
 * SEPARATE counter for that reason, incremented/decremented at the SAME one shared attach point
 * (`ToolRegistry.dispatch`, unconditionally — see mcp/registry.ts) rather than inferred from a
 * session-scoped structure that does not cover every call.
 */
let globalDispatchInFlight = 0;
/** Epoch ms of the last dispatch activity (a call starting OR finishing), process-wide. 0 means
 *  "no dispatch has happened yet this process" — `msSinceLastDispatchActivity` reads that as
 *  infinitely idle rather than as a recent event at the epoch. */
let lastDispatchActivityAt = 0;

/** Mark one more dispatch call in flight, process-wide. Returns a release function — call it
 *  exactly once when that call finishes, success or throw; a duplicate call is a no-op. Mirrors
 *  `markInFlight`'s shape (reference-counted, idempotent release) but is unconditional: called for
 *  EVERY dispatch, not only ones with a `sessionId`. */
export function markDispatchActive(): () => void {
  globalDispatchInFlight += 1;
  lastDispatchActivityAt = Date.now();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    globalDispatchInFlight = Math.max(0, globalDispatchInFlight - 1);
    lastDispatchActivityAt = Date.now();
  };
}

/** True while at least one dispatch call is in flight, process-wide. */
export function dispatchInFlightCount(): number {
  return globalDispatchInFlight;
}

/** Milliseconds since the last dispatch activity (a call starting or finishing), process-wide.
 *  `Number.POSITIVE_INFINITY` before this process has dispatched its first call — never busy, so
 *  immediately idle rather than "just active at epoch 0". */
export function msSinceLastDispatchActivity(now: number = Date.now()): number {
  return lastDispatchActivityAt === 0 ? Number.POSITIVE_INFINITY : now - lastDispatchActivityAt;
}

/** How many calls currently have `sessionId` attached. 0 — the common case — means nothing is
 *  calling through it right now, not that the session is invalid. */
export function inFlightCount(sessionId: string): number {
  return inFlightCounts.get(sessionId) ?? 0;
}
