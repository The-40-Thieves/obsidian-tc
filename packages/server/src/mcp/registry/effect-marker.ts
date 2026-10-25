// The commit signal a handler sends through ctx.markEffectCommitted, installed on the caller's context
// for a call that owns an idempotency claim or carries a confirmation token its handler may spend.
import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";

type Marked = { markEffectCommitted?: () => void };

/** Installs `onCommit` as the call's marker and returns the function that removes it. A context that
 *  already carries a marker is refused, keyed or not: two concurrent dispatches sharing one
 *  CallerContext would otherwise overwrite or chain each other's callback, so one call's commit could
 *  land on the other's claim or token. The removal clears only this dispatch's own callback. */
export function installEffectMarker(
  callerCtx: object,
  ctx: object,
  onCommit: () => void,
): () => void {
  const slot = callerCtx as Marked;
  if (slot.markEffectCommitted !== undefined) {
    throw new ObsidianTcError(
      "internal",
      "CallerContext is already in use by an in-flight dispatch; a context must not be shared across concurrent dispatches",
    );
  }
  slot.markEffectCommitted = onCommit;
  // `ctx` may be a per-call copy (withEffectiveVault), which the handler reads the marker from.
  if (ctx !== callerCtx) (ctx as Marked).markEffectCommitted = onCommit;
  return () => {
    if (slot.markEffectCommitted === onCommit) slot.markEffectCommitted = undefined;
  };
}
