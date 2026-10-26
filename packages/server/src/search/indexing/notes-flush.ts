// The notes pass's per-batch write, split out of index-vault.ts (700-line ceiling; see
// sweep-notes.ts). One write transaction per batch. A batch whose leader epoch went stale (a
// successor promoted since this reconcile run started) writes nothing: its notes rows and FTS
// bodies are as stale as a chunk batch's, so the whole batch is dropped.
import { inWriteTransaction } from "../../db/txn";
import { type NoteRecord, upsertNoteRow } from "../fts";
import { bumpGeneration } from "../generation";
import { readLeaderEpoch } from "./leader-epoch";
import type { IndexVaultArgs } from "./types";
import { commitFence } from "./write-fence";

/** The rows landed, or null when the batch was dropped as stale. */
export function flushNoteRows(
  args: IndexVaultArgs,
  rows: NoteRecord[],
  hasFts: boolean,
  demoted: ReadonlySet<string>,
  now: () => number,
): number | null {
  let epochStale = false;
  const upserted = inWriteTransaction(
    args.db,
    "index_notes_flush",
    () => {
      // Read inside the transaction, as the chunk apply does (index-vault.ts index_batch).
      epochStale = args.leaderEpoch !== undefined && readLeaderEpoch(args.db) !== args.leaderEpoch;
      if (epochStale) return 0;
      let landed = 0;
      for (const rec of rows) {
        // Fix round (cross-vendor review): a notes-row-only backfill (plan==null but the row is
        // missing/stale) previously bypassed BOTH fences entirely — a demoted leader's stale
        // metadata could overwrite fresher content, or resurrect a note's search-visible row
        // after a successor's deindex, since neither commitFence nor readLeaderEpoch ever ran
        // for this write. Same commit-time re-check as applyNoteWrites, but only when this row is
        // the SOLE write for its path this pass — see NoteRecord.fenceCheckRequired's own
        // comment for why a plan-carrying row must NOT also bump this same generation here.
        if (rec.fenceCheckRequired) {
          const fence = commitFence(args.db, args.vaultId, rec.path, rec.fenceGeneration, now());
          if (!fence.ok) continue;
        }
        upsertNoteRow(args.db, args.vaultId, rec, hasFts, now());
        landed += 1;
      }
      // A promoted identity moves the permitted-path sets, as syncAclPaths' own writes do.
      if (rows.some((r) => demoted.has(r.path))) bumpGeneration(args.db, args.vaultId);
      return landed;
    },
    args.sql,
  );
  return epochStale ? null : upserted;
}
