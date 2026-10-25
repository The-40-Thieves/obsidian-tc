// The commit signal a handler sends through ctx.markEffectCommitted (THE-572, THE-573), installed on
// the caller's context for a call that owns an idempotency claim or spent a confirmation (GH #1381).
import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";

type Marked = { markEffectCommitted?: () => void };

/** Installs `onCommit` as the call's marker and returns the function that restores what was there.
 *  A keyed call refuses a context another dispatch already marks (two concurrent dispatches sharing one
 *  CallerContext would silently overwrite each other's callback). A keyless call only spends a
 *  confirmation, so a marker the caller set is chained rather than refused: both are signalled. */
export function installEffectMarker(
  callerCtx: object,
  ctx: object,
  claimedKey: string | undefined,
  onCommit: () => void,
): () => void {
  const slot = callerCtx as Marked;
  if (claimedKey !== undefined && slot.markEffectCommitted !== undefined) {
    throw new ObsidianTcError(
      "internal",
      "CallerContext is already in use by an in-flight dispatch; a context must not be shared across concurrent dispatches",
    );
  }
  const prior = slot.markEffectCommitted;
  slot.markEffectCommitted = () => {
    prior?.();
    onCommit();
  };
  // `ctx` may be a per-call copy (withEffectiveVault), which the handler reads the marker from.
  if (ctx !== callerCtx) (ctx as Marked).markEffectCommitted = slot.markEffectCommitted;
  return () => {
    slot.markEffectCommitted = prior;
  };
}
