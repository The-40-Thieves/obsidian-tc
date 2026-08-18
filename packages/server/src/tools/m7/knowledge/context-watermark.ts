// THE-647 item 1: the per-(caller, vault) watermark backing differential vault_context
// (migration 20260818_001_vault_context_watermark.sql). Borrows THE-461's discipline
// (experiential/activation.ts's recomputeActivation) rather than re-deriving it: the value
// persisted here is captured BEFORE the diff read runs and written only AFTER the response is
// composed successfully, and it never regresses (MAX with whatever is already stored).
//
// A well-behaved client that always echoes the previous response's `diff_since` back as its next
// `since` never has a row dropped by this mechanism: anything written between capture and the
// read still carries a timestamp past the OLD watermark (so it is included THIS call), and
// nothing written after capture can carry a timestamp at or before the captured value — so the
// NEXT call (filtering on that captured value) will still see it. See
// context-watermark.test.ts's "a concurrent write between capture and advance is not skipped by
// the next diff call" for the case this exists to close.
import type { Database } from "../../../db/types";

/** `vault_context_watermark.caller` is NOT NULL (composite PK cannot carry NULL meaningfully);
 *  coerce CallerContext's nullable `caller` the same way the rest of dispatch treats an absent
 *  principal — an empty string, never conflated with a real caller id. */
export function watermarkCallerKey(caller: string | null | undefined): string {
  return caller ?? "";
}

/** The caller+vault's last-persisted diff watermark (ms epoch), or 0 when no row exists yet —
 *  0 makes a caller's first-ever diff call see everything, mirroring activation_state's own
 *  "watermark 0 seeds a full pass" convention. */
export function readContextWatermark(db: Database, caller: string | null, vaultId: string): number {
  const row = db
    .prepare("SELECT watermark FROM vault_context_watermark WHERE caller = ? AND vault_id = ?")
    .get(watermarkCallerKey(caller), vaultId) as { watermark: number } | undefined;
  return row?.watermark ?? 0;
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
