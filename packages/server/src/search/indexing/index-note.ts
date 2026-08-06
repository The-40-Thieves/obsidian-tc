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
import { deleteChunkSparse, ensureChunkSparse } from "../sparse";
import { EMBED_BATCH, EMBED_CONCURRENCY, embedPlans } from "./embed-batches";
import { computeNotePlan, hasBodyShaColumn } from "./note-plan";
import { applyNoteWrites, DELETE_CONTRADICTIONS_SQL, fireIndexHook } from "./persist-note-plan";
import type { IndexHook, PlanResult } from "./types";

// Single-note plan + embed (indexNote / index-on-write path). indexVault batches embeds instead.
async function planNoteWrites(
  db: Database,
  provider: EmbeddingProvider,
  vaultId: string,
  path: string,
  raw: string,
  ts: number,
  enrich: boolean,
): Promise<PlanResult> {
  // THE-531: pass the active model so an unchanged note whose vectors are from a superseded model is
  // still re-embedded.
  const res = computeNotePlan(db, vaultId, path, raw, ts, enrich, undefined, false, provider.id);
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
): Promise<{ upserted: number; deleted: number; unchanged: number; secretsSkipped: number }> {
  const { plan, unchanged, secretsSkipped, flagged } = await planNoteWrites(
    db,
    provider,
    vaultId,
    path,
    raw,
    now(),
    enrich,
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
      inWriteTransaction(
        db,
        "index_note",
        () => upsertNoteRow(db, vaultId, note, hasFts, now()),
        sql,
      );
    }
    return { upserted: 0, deleted: 0, unchanged, secretsSkipped };
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
      if (note) upsertNoteRow(db, vaultId, note, hasFts, now());
      // THE-496: this note's chunks/embeddings changed (the plan-null early return above skips a
      // no-op), so bump the vault generation inside the SAME transaction — the query cache must not
      // serve pre-mutation results.
      if (r.upserted > 0 || r.deleted > 0) bumpGeneration(db, vaultId);
      return r;
    },
    sql,
  );
  fireIndexHook(onIndexed, plan);
  return { ...result, unchanged, secretsSkipped };
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
      const delContra = tableExists(db, "contradictions")
        ? cachedPrepare(db, DELETE_CONTRADICTIONS_SQL)
        : null;
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
    },
    sql,
  );
}
