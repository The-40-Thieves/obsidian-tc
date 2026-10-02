// WP3 slice 3 (docs/plans/2026-07-30-codebase-refactor-map.md): single-note orchestration, moved
// verbatim out of indexer.ts — planNoteWrites (plan + embed a single note, outside any transaction),
// indexNote (plan then prune+upsert atomically) and deindexNote (drop everything indexed for a
// path). These own the WRITE TRANSACTION boundary (inWriteTransaction) for the single-note / deindex
// paths: applyNoteWrites (persist-note-plan.ts) executes INSIDE it, and the vault_generation bump
// happens as the LAST write in the SAME transaction, after applyNoteWrites returns — a placement
// test/indexer-transaction-rollback.test.ts depends on. indexVault (index-vault.ts) is the batched
// counterpart and imports deindexNote from here for its stale-path sweep; that sibling direction is
// fine (only importing indexer.ts itself, the facade, would be a cycle).
import { err } from "@the-40-thieves/obsidian-tc-shared";
import { tableExists } from "../../db/introspect";
import { inWriteTransaction, type WriteTxnHooks } from "../../db/txn";
import { cachedPrepare, type Database } from "../../db/types";
import type { EmbeddingProvider } from "../../embeddings";
import { deleteChunkColbert, ensureChunkColbert } from "../chunk_colbert";
import { deleteChunkFtsRow, ensureChunkFts } from "../chunk_fts";
import {
  buildNoteRecord,
  deleteNoteRow,
  ensureNotesFts,
  hasNotesTable,
  type NoteRecord,
  noteRowHash,
  upsertNoteRow,
} from "../fts";
import { bumpGeneration } from "../generation";
import { deleteNoteSummary } from "../note-summaries";
import { deleteChunkSparse, ensureChunkSparse } from "../sparse";
import { EMBED_BATCH, EMBED_CONCURRENCY, embedPlans } from "./embed-batches";
import { computeNotePlan, hasBodyShaColumn } from "./note-plan";
import { applyNoteWrites, DELETE_CONTRADICTIONS_SQL, fireIndexHook } from "./persist-note-plan";
import type { IndexHook, PlanResult } from "./types";
import { bumpFenceUnconditional, commitFence } from "./write-fence";

// Single-note plan + embed (indexNote / index-on-write path). indexVault batches embeds instead.
async function planNoteWrites(
  db: Database,
  provider: EmbeddingProvider,
  vaultId: string,
  path: string,
  raw: string,
  ts: number,
  enrich: boolean,
  /** THE-934 fix round 1 (Blocking-1): egress.excludePaths, as a per-path predicate. Undefined ->
   *  nothing excluded. Without this, the single-note index-on-write path (write_note/append_note/
   *  patch_note, the vault watcher, and a move/rename INTO an excluded folder) sent excluded note
   *  text to the embedding provider — the batched indexVault reconcile got this in round 0, this
   *  path did not. */
  isExcluded?: (rel: string) => boolean,
): Promise<PlanResult> {
  // THE-531: pass the active model so an unchanged note whose vectors are from a superseded model is
  // still re-embedded.
  const res = computeNotePlan(
    db,
    vaultId,
    path,
    raw,
    ts,
    enrich,
    undefined,
    false,
    provider.id,
    undefined,
    undefined,
    isExcluded,
  );
  if (res.plan) {
    const { failed } = await embedPlans(provider, [res.plan], EMBED_BATCH, EMBED_CONCURRENCY);
    // Index-on-write is a single note: a quarantined chunk means the note cannot be applied,
    // so keep the caller's existing best-effort failure semantics (counted as a write failure)
    // rather than writing a partial note.
    if (failed.length > 0) {
      throw err.embeddingProviderError(
        "provider rejected a single-chunk embed request (over its context?)",
        { provider: provider.provider, path },
      );
    }
  }
  return res;
}

// Index a single note atomically: plan (incl. embed, outside the txn), then prune + upsert in one
// transaction. Used by the index-on-write / deindex paths; indexVault batches instead.
export async function indexNote(
  db: Database,
  provider: EmbeddingProvider,
  vaultId: string,
  path: string,
  raw: string,
  hasVec: boolean,
  now: () => number,
  onIndexed?: IndexHook,
  /** THE-406: embeddings.chunkContext — enrich the embedded/BM25 text with title + breadcrumb. */
  enrich = false,
  /** THE-585 (#5): write-lock observability hooks. This is the index-ON-WRITE path, so its samples
   *  are the ones that show a live tool call blocking behind a running reindex — the contention
   *  THE-467/468 is actually about. */
  sql?: WriteTxnHooks,
  /** THE-934 fix round 1 (Blocking-1): egress.excludePaths, as a per-path predicate. Threaded
   *  through to planNoteWrites/computeNotePlan — see that function's doc comment. */
  isExcluded?: (rel: string) => boolean,
): Promise<{
  upserted: number;
  deleted: number;
  unchanged: number;
  secretsSkipped: number;
  /** GH #995 follow-up: true when this write was dropped by the commit-time fence (write-fence.ts)
   *  — a fresher write or deindex committed for this path between this call's plan and its apply.
   *  No row was touched; the caller's coalescing (index-coordinator.ts) or the next reconcile will
   *  naturally re-settle the path to its actual current content. */
  staleSkipped: boolean;
}> {
  const { plan, unchanged, secretsSkipped, flagged, fenceGeneration } = await planNoteWrites(
    db,
    provider,
    vaultId,
    path,
    raw,
    now(),
    enrich,
    isExcluded,
  );
  // THE-291: the metadata/FTS row rides the same write (skip empty content — a true delete goes
  // through deindexNote; an empty note has nothing to index).
  const hasNotes = hasNotesTable(db);
  const hasFts = hasNotes && ensureNotesFts(db, { now });
  const hasChunkFts = ensureChunkFts(db, { now, enrich });
  const hasEmbedFull = typeof provider.embedFull === "function";
  const hasChunkSparse = hasEmbedFull && ensureChunkSparse(db);
  const hasChunkColbert = hasEmbedFull && ensureChunkColbert(db);
  const hasBodySha = hasBodyShaColumn(db);
  const note: NoteRecord | null =
    hasNotes && raw !== "" ? buildNoteRecord(path, raw, flagged, null, now()) : null;
  if (!plan) {
    // Chunks unchanged; refresh the notes row only when missing/stale (backfill path).
    if (note && noteRowHash(db, vaultId, path) !== note.contentHash) {
      // Fix round (cross-vendor review): this backfill previously wrote unconditionally — no
      // fence check at all — so a demoted leader's stale metadata could overwrite fresher content,
      // or resurrect a note's search-visible row after a successor's deindex tombstone, between
      // this plan's read (fenceGeneration, captured above by planNoteWrites) and this write. Same
      // commit-time re-check applyNoteWrites already does for a real chunk plan, inside the SAME
      // transaction.
      const landed = inWriteTransaction(
        db,
        "index_note",
        () => {
          const fence = commitFence(db, vaultId, path, fenceGeneration, now());
          if (!fence.ok) return false;
          upsertNoteRow(db, vaultId, note, hasFts, now());
          return true;
        },
        sql,
      );
      if (!landed)
        return { upserted: 0, deleted: 0, unchanged, secretsSkipped, staleSkipped: true };
    }
    return { upserted: 0, deleted: 0, unchanged, secretsSkipped, staleSkipped: false };
  }
  const result = inWriteTransaction(
    db,
    "index_note",
    () => {
      const r = applyNoteWrites(
        db,
        provider,
        vaultId,
        plan,
        hasVec,
        hasChunkFts,
        hasChunkSparse,
        hasChunkColbert,
        hasBodySha,
        new Map(), // THE-488: single-note path — a fresh (effectively empty) dedup cache
      );
      // GH #995 follow-up: a stale-fenced write touched NO rows (applyNoteWrites returned before
      // writing anything) — the notes/FTS row and the vault_generation bump must stay untouched
      // too, or a dropped chunk write would still be reported as a content change.
      if (r.staleSkipped) return r;
      if (note) upsertNoteRow(db, vaultId, note, hasFts, now());
      // THE-496: this note's chunks/embeddings changed (the plan-null early return above skips a
      // no-op), so bump the vault generation inside the SAME transaction — the query cache must not
      // serve pre-mutation results.
      if (r.upserted > 0 || r.deleted > 0) bumpGeneration(db, vaultId);
      return r;
    },
    sql,
  );
  // GH #995 follow-up: never fire the (re)embedded-chunk hook for a write the fence dropped — its
  // chunks were never committed (persist-note-plan.ts's own header: "a consumer never observes an
  // uncommitted (possibly rolled-back) chunk", and a fenced-out write is the same case).
  if (!result.staleSkipped) fireIndexHook(onIndexed, plan);
  return { ...result, unchanged, secretsSkipped };
}

/**
 * Dismiss (never delete) the open contradiction rows that name `path` on either side. The row keeps
 * its judge verdict as the audit trail and gains status 'dismissed' + a reason, the same shape the
 * re-judge command writes, so every reader that filters `status = 'open'` stops surfacing it.
 */
function dismissContradictionsForPath(
  db: Database,
  vaultId: string,
  path: string,
  reason: string,
  at: number,
): void {
  cachedPrepare(
    db,
    "UPDATE contradictions SET status = 'dismissed', resolved_at = ?, resolution_reason = ? WHERE vault_id = ? AND status = 'open' AND (source_path = ? OR conflict_path = ?)",
  ).run(at, reason, vaultId, path, path);
}

/** Is anything indexed for this path (chunks, a notes/FTS row, or a note summary)? */
export function hasIndexedState(db: Database, vaultId: string, path: string): boolean {
  const probe = (sql: string): boolean => cachedPrepare(db, sql).get(vaultId, path) !== undefined;
  if (probe("SELECT 1 FROM chunks WHERE vault_id = ? AND path = ? LIMIT 1")) return true;
  if (hasNotesTable(db) && probe("SELECT 1 FROM notes WHERE vault_id = ? AND path = ? LIMIT 1"))
    return true;
  return (
    tableExists(db, "note_summaries") &&
    probe("SELECT 1 FROM note_summaries WHERE vault_id = ? AND path = ? LIMIT 1")
  );
}

/**
 * THE-291: drop EVERYTHING indexed for a path — chunks, embeddings, vec rows, and the notes +
 * FTS metadata — in one transaction. The delete/move paths call this instead of the legacy
 * empty-content reindex (which cannot distinguish a deleted note from an empty one for the
 * notes table).
 */
export function deindexNote(
  db: Database,
  vaultId: string,
  path: string,
  hasVec: boolean,
  /** THE-408: embeddings.chunkContext — a divergence-rebuild fired from this path must match the
   *  index's enrichment. */
  enrich = false,
  /** THE-585 (#5): write-lock observability hooks; see indexNote. */
  sql?: WriteTxnHooks,
  /** GH #995 follow-up: stamps the tombstone bump below (write-fence.ts's bumpFenceUnconditional).
   *  Defaults to Date.now, matching indexNote's own `now` default shape. */
  now: () => number = Date.now,
  /** Set when the path is being de-indexed because it became EXCLUDED (Obsidian's Excluded files /
   *  index.excludePaths), not because it was deleted: its open contradiction rows are dismissed with
   *  this reason (the re-judge path's own status/resolution_reason shape) instead of being deleted
   *  with the chunks, and its note summary is dropped. */
  excludedReason?: string,
): void {
  const hasNotes = hasNotesTable(db);
  const hasFts = hasNotes && ensureNotesFts(db);
  const hasChunkFts = ensureChunkFts(db, { enrich });
  const hasChunkSparse = tableExists(db, "chunk_sparse");
  const hasChunkColbert = tableExists(db, "chunk_colbert");
  inWriteTransaction(
    db,
    "index_deindex",
    () => {
      // THE-316: static-arity SQL on the deindex write path (also driven once per note in the
      // stale-path sweep) — cache by SQL text so the sweep does not recompile these on every call.
      // THE-711 follow-up: `rowid` is selected alongside `id` because chunk_fts is contentless and
      // can only be deleted from by rowid — and that rowid stops being resolvable the moment the
      // chunks row goes. Captured here, used at the delete below, before delChunk runs.
      const rows = cachedPrepare(
        db,
        "SELECT rowid, id FROM chunks WHERE vault_id = ? AND path = ?",
      ).all(vaultId, path) as Array<{ rowid: number; id: string }>;
      const delEmb = cachedPrepare(db, "DELETE FROM chunk_embeddings WHERE chunk_id = ?");
      const delChunk = cachedPrepare(db, "DELETE FROM chunks WHERE id = ?");
      const delVec = hasVec ? cachedPrepare(db, "DELETE FROM vec_chunks WHERE chunk_id = ?") : null;
      // #280-followup: drop the deleted note's chunks' contradiction flags (plane table optional).
      const hasContra = tableExists(db, "contradictions");
      const delContra =
        hasContra && excludedReason === undefined
          ? cachedPrepare(db, DELETE_CONTRADICTIONS_SQL)
          : null;
      if (hasContra && excludedReason !== undefined)
        dismissContradictionsForPath(db, vaultId, path, excludedReason, now());
      if (excludedReason !== undefined) deleteNoteSummary(db, vaultId, path);
      for (const r of rows) {
        // FTS first: it is the only delete here whose key (rowid) is owned by the chunks row, so
        // it is the only one that must not follow delChunk.
        if (hasChunkFts) deleteChunkFtsRow(db, r.rowid);
        delEmb.run(r.id);
        delChunk.run(r.id);
        if (delVec) delVec.run(r.id);
        if (hasChunkSparse) deleteChunkSparse(db, r.id);
        if (hasChunkColbert) deleteChunkColbert(db, r.id);
        if (delContra) delContra.run(r.id, r.id);
      }
      if (hasNotes) deleteNoteRow(db, vaultId, path, hasFts);
      // THE-496: a removed path drops chunks/edges from the searchable set, so bump the generation in
      // the same transaction when anything was actually deleted.
      if (rows.length > 0) bumpGeneration(db, vaultId);
      // GH #995 follow-up: the tombstone — bumped UNCONDITIONALLY, even when rows.length === 0 (a
      // path never yet indexed). A delete is always the fresher signal: any write plan read BEFORE
      // this transaction commits, for this same path, carries a generation this bump moves past, so
      // its eventual commit (persist-note-plan.ts's applyNoteWrites) is fenced out regardless of
      // whether this delete actually removed rows. See the migration's own header.
      bumpFenceUnconditional(db, vaultId, path, now());
    },
    sql,
  );
}
