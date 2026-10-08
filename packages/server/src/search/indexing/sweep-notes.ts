// The two sweeps indexVault runs after its notes pass, split out of index-vault.ts (700-line
// ceiling): drop the index state of (1) notes on the vault's Excluded files list and (2) notes no
// longer on disk. Both go through deindexNote (index-note.ts, a sibling import, not a cycle).
import { EXCLUDED_DISMISS_REASON } from "../index-exclusion";
import { deindexNote, hasIndexedState } from "./index-note";
import type { IndexVaultArgs } from "./types";

export interface SweepInput {
  args: IndexVaultArgs;
  hasVec: boolean;
  now: () => number;
  /** Every path the UNFILTERED walk saw (so an ACL-hidden file is not mistaken for a deleted one). */
  walkedSet: { has(path: string): boolean };
  excludedWalked: readonly string[];
  /** Run the stale-path sweep: unscoped runs on a vault with a notes table only. A folder-scoped
   *  index_vault call must never deindex the rest of the vault. */
  sweepGone: boolean;
  /** Mutated: every path whose chunks/tags are gone, for the derived-edge delta passes. */
  deletedPaths: Set<string>;
  changedChunkPaths: Set<string>;
}

/** Returns how many notes were de-indexed. */
export function sweepUnindexedNotes(i: SweepInput): number {
  const { args } = i;
  let deleted = 0;
  const drop = (path: string, dismissReason?: string): void => {
    deindexNote(
      args.db,
      args.vaultId,
      path,
      i.hasVec,
      args.chunkContext === true,
      args.sql,
      i.now,
      dismissReason,
    );
    deleted += 1;
    // A deleted note's chunk embeddings AND its tags are both gone: both delta computations need to
    // know, so its derived edges in both directions get pruned rather than orphaned.
    i.deletedPaths.add(path);
    i.changedChunkPaths.add(path);
  };
  // An excluded note owns no index state: remove whatever an earlier pass (before it was excluded)
  // left (chunks, vectors, FTS and notes rows, summary) and dismiss its open contradiction rows with
  // a reason. Idempotent; a steady-state pass pays one existence probe per excluded note. Runs
  // before the stale sweep so that sweep never sees these rows.
  for (const rel of i.excludedWalked) {
    if (hasIndexedState(args.db, args.vaultId, rel)) drop(rel, EXCLUDED_DISMISS_REASON);
  }
  if (i.sweepGone) {
    const known = args.db
      .prepare("SELECT path FROM notes WHERE vault_id = ?")
      .all(args.vaultId) as Array<{ path: string }>;
    for (const row of known) if (!i.walkedSet.has(row.path)) drop(row.path);
  }
  return deleted;
}
