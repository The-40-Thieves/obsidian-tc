// THE-647 item 1: the per-(caller, vault) watermark backing differential vault_context
// (migration 20260818_001_vault_context_watermark.sql). Borrows THE-461's discipline
// (experiential/activation.ts's recomputeActivation) rather than re-deriving it: the value
// persisted here is captured BEFORE the diff read runs and written only AFTER the response is
// composed successfully, and it never regresses (MAX with whatever is already stored).
//
// FLOOR, not the filter of record. `since` is a client-supplied LOWER-BOUND HINT — vault_context
// filters on `min(clientSinceMs, storedWatermarkMs)` when a stored row exists (readContextWatermark
// returns undefined, not 0, when there is none, so a caller's genuinely first diff call is exactly
// client-since behavior — no row to floor against). A naive implementation that trusted the
// client's `since` unconditionally would silently drop rows the moment a client's own clock ran
// ahead of the server's (or a client used a stale/cached cutoff): the row exists, has a timestamp
// between the true previous watermark and the client's (too-late) `since`, and a plain `WHERE ts >
// clientSince` filter would just never return it, forever, with no error and no signal to the
// caller. Flooring makes OVER-delivery (a superset — the same row shows up again on a later call)
// the failure mode instead of loss, which is the correct trade for a diff surface: an idempotent
// caller re-processing an already-seen row is cheap; a caller that never learns a row existed
// cannot recover at all.
//
// `advanceContextWatermark`'s OWN discipline is unrelated to which cutoff filtered the read: the
// value it persists is captured BEFORE the diff queries run and written only AFTER the response is
// composed successfully, so anything written between capture and the read still carries a
// timestamp past the OLD watermark (included THIS call), and nothing written after capture can
// carry a timestamp at or before the captured value (so the NEXT call still sees it via either the
// client's own since or the floor). See context-watermark.test.ts's "a concurrent write between
// capture and advance is not skipped by the next diff call" (the capture-before-read/advance-after
// ordering) and "the floor catches a row the client's own since would have skipped" (a client clock
// running ahead of a stored watermark) for the two cases this exists to close.
import type { Database } from "../../../db/types";

/** `vault_context_watermark.caller` is NOT NULL (composite PK cannot carry NULL meaningfully);
 *  coerce CallerContext's nullable `caller` the same way the rest of dispatch treats an absent
 *  principal — an empty string, never conflated with a real caller id. */
export function watermarkCallerKey(caller: string | null | undefined): string {
  return caller ?? "";
}

/** The caller+vault's last-persisted diff watermark (ms epoch), or `undefined` when NO ROW exists
 *  yet — distinct from a row whose watermark happens to be 0. `undefined` is what tells the caller
 *  "this is a genuinely first diff call; use the client's `since` as-is, there is nothing to floor
 *  against" (see the module doc comment's floor semantics). */
export function readContextWatermark(
  db: Database,
  caller: string | null,
  vaultId: string,
): number | undefined {
  const row = db
    .prepare("SELECT watermark FROM vault_context_watermark WHERE caller = ? AND vault_id = ?")
    .get(watermarkCallerKey(caller), vaultId) as { watermark: number } | undefined;
  return row?.watermark;
}

/** Persist a new watermark for (caller, vault), never regressing below whatever is already
 *  stored — call ONLY after the diff response it was captured for has been composed
 *  successfully. `capturedAtMs` MUST have been captured BEFORE the diff read ran (see the module
 *  doc comment); passing a value captured afterward reopens the exact race this table exists to
 *  close. */
export function advanceContextWatermark(
  db: Database,
  caller: string | null,
  vaultId: string,
  capturedAtMs: number,
): void {
  const key = watermarkCallerKey(caller);
  db.prepare(
    `INSERT INTO vault_context_watermark (caller, vault_id, watermark) VALUES (?, ?, ?)
     ON CONFLICT(caller, vault_id) DO UPDATE SET watermark = MAX(watermark, excluded.watermark)`,
  ).run(key, vaultId, capturedAtMs);
}
