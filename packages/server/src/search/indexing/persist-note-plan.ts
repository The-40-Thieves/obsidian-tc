// WP3 slice 2 (docs/plans/2026-07-30-codebase-refactor-map.md): the transactional SQL-application
// phase, moved verbatim out of indexer.ts — chunk rows, FTS, vector/sparse/ColBERT synchronisation,
// contradiction cleanup, and the index hook notification that follows a committed plan. applyNoteWrites
// executes INSIDE THE CALLER'S EXISTING WRITE TRANSACTION and performs NO embedding calls (the
// plan's vectors were already computed by embedPlans, outside any transaction) and NO transaction
// control of its own — it must never open, commit, or roll back a transaction; indexNote/indexVault
// (WP3 slice 3: index-note.ts / index-vault.ts) own that boundary and continue to. The
// vault_generation bump is NOT made from here: it is the orchestrator's job, made as the LAST write
// in the SAME transaction that calls applyNoteWrites (see indexNote) — a placement
// test/indexer-transaction-rollback.test.ts depends on. dedup.ts (the cross-path embedding-copy
// lookup) and index-note.ts/index-vault.ts (orchestration) both depend on this file; this file must
// depend on neither of them.
import { tableExists } from "../../db/introspect";
import { cachedPrepare, type Database } from "../../db/types";
import type { EmbeddingProvider } from "../../embeddings";
import { deleteChunkColbert, upsertChunkColbert } from "../chunk_colbert";
import { deleteChunkFtsRow, upsertChunkFtsRow } from "../chunk_fts";
import { deleteChunkSparse, upsertChunkSparse } from "../sparse";
import { floatBlob, upsertVec } from "../vec";
import { copyDedupVectors } from "./dedup";
import type { DedupCache, IndexHook, NoteWritePlan } from "./types";

// #280-followup: a chunk's contradiction flags are judged on its exact content; when the chunk is
// pruned or re-embedded (content changed) they are stale and must be dropped, or "open" rows accrue
// unbounded and pollute the synthesis / knowledge_challenge / reflect grounding (all read
// status='open'). Tied to chunk lifetime here, alongside the fts/vec/sparse/colbert cleanup. Exported
// because deindexNote (index-note.ts) shares the same delete-on-chunk-lifetime rule for a whole-note
// delete, not only a prune/re-embed.
export const DELETE_CONTRADICTIONS_SQL =
  "DELETE FROM contradictions WHERE source_chunk_id = ? OR conflict_chunk_id = ?";

// Apply a note's write plan (prune + upserts). Contains NO transaction control — the CALLER owns
// BEGIN/COMMIT/ROLLBACK, so one transaction can batch many notes' applies.
export function applyNoteWrites(
  db: Database,
  provider: EmbeddingProvider,
  vaultId: string,
  plan: NoteWritePlan,
  hasVec: boolean,
  hasChunkFts: boolean,
  hasChunkSparse: boolean,
  hasChunkColbert: boolean,
  /** migration 20260719_001: write the raw-body hash column only when it exists. */
  hasBodySha: boolean,
  /** THE-488: per-flush memo of dedup source vectors by content_hash, shared across the batch's notes
   *  so a duplicate's JOIN runs once per distinct content_hash. */
  dedupCache: DedupCache,
): { upserted: number; deleted: number; dedupUnresolved: number } {
  // THE-316: static-arity SQL on the per-note reconcile write path — cache the compiled statements
  // by SQL text (cachedPrepare) so a 100-note flush recompiles these five once for the process, not
  // once per note. The vec0 DELETE is prepared only when the extension loaded — the table may not
  // exist otherwise.
  const delEmb = cachedPrepare(db, "DELETE FROM chunk_embeddings WHERE chunk_id = ?");
  // THE-531: when a chunk is re-embedded under the current model, deactivate any OTHER-model rows for
  // it — PRIMARY KEY (chunk_id, model) lets both coexist, so "active" must mean "current
  // representation", not "ever generated". A superseded row stays in the table (audit/rollback) but
  // is_active = 0 so retrieval and the vec rebuild ignore it.
  const deactivateOld = cachedPrepare(
    db,
    "UPDATE chunk_embeddings SET is_active = 0 WHERE chunk_id = ? AND model != ? AND is_active = 1",
  );
  const delChunk = cachedPrepare(db, "DELETE FROM chunks WHERE id = ?");
  const delVec = hasVec ? cachedPrepare(db, "DELETE FROM vec_chunks WHERE chunk_id = ?") : null;
  // body_sha rides the same upsert when the column exists (migration 20260719_001); cachedPrepare
  // keys on the SQL text, so the with/without-column variants compile independently and a pre-migration
  // cache.db never sees the extra column.
  // `contradictions` is an optional plane table — gate on a cheap in-memory sqlite_master check.
  const delContra = tableExists(db, "contradictions")
    ? cachedPrepare(db, DELETE_CONTRADICTIONS_SQL)
    : null;
  const upChunk = cachedPrepare(
    db,
    hasBodySha
      ? "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, body_sha, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET chunk_index = excluded.chunk_index, headings = excluded.headings, content = excluded.content, content_hash = excluded.content_hash, body_sha = excluded.body_sha, token_count = excluded.token_count, updated_at = excluded.updated_at"
      : "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET chunk_index = excluded.chunk_index, headings = excluded.headings, content = excluded.content, content_hash = excluded.content_hash, token_count = excluded.token_count, updated_at = excluded.updated_at",
  );
  const upEmb = cachedPrepare(
    db,
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(chunk_id, model) DO UPDATE SET dimensions = excluded.dimensions, embedding = excluded.embedding, is_active = 1, generated_at = excluded.generated_at",
  );
  // THE-711 follow-up: resolves a chunk id to the rowid a contentless chunk_fts entry keys on.
  const rowidOf = cachedPrepare(db, "SELECT rowid FROM chunks WHERE id = ?");
  let deleted = 0;
  let dedupUnresolved = 0;
  for (const e of plan.existing) {
    if (plan.desiredIds.has(e.id)) continue;
    // FTS first. Its key is the chunks rowid, which stops resolving once delChunk runs — this
    // ordering used to be the other way round, and under a contentless index that would have
    // orphaned an entry on every delete. See deleteChunkFtsRow's header for why an orphan is a
    // full-reindex-on-every-open problem rather than a stale-row problem.
    if (hasChunkFts) deleteChunkFtsRow(db, e.rowid);
    delEmb.run(e.id);
    delChunk.run(e.id);
    if (delVec) delVec.run(e.id);
    if (hasChunkSparse) deleteChunkSparse(db, e.id);
    if (hasChunkColbert) deleteChunkColbert(db, e.id);
    if (delContra) delContra.run(e.id, e.id);
    deleted += 1;
  }
  plan.toEmbed.forEach((d, i) => {
    // A re-embedded chunk changed content; its prior contradiction flags are stale. Drop them —
    // the onIndexed contradiction job re-detects against the new content.
    if (delContra) delContra.run(d.id, d.id);
    const vec = plan.vectors[i] ?? [];
    // Every chunk is STORED — the chunk row lands regardless of the dedup decision. body_sha is
    // passed only when the column exists.
    if (hasBodySha) {
      upChunk.run(
        d.id,
        vaultId,
        plan.path,
        d.index,
        JSON.stringify(d.headings),
        d.content,
        d.contentHash,
        d.bodySha,
        d.tokenCount,
        plan.ts,
        plan.ts,
      );
    } else {
      upChunk.run(
        d.id,
        vaultId,
        plan.path,
        d.index,
        JSON.stringify(d.headings),
        d.content,
        d.contentHash,
        d.tokenCount,
        plan.ts,
        plan.ts,
      );
    }
    // Cross-path dedup (migration 20260719_001): a reused/skipped body was never sent to the
    // provider this run. THE-454: instead of writing NO vector (which left the chunk invisible to
    // dense/sparse/ColBERT retrieval and stranded it when the owner was deleted), COPY the identical
    // body's already-stored vectors from the first walked path — same provider call cost, but every
    // path stays semantically retrievable.
    if (!d.skipEmbed) {
      upEmb.run(d.id, provider.id, provider.dimensions, floatBlob(vec), plan.ts);
      deactivateOld.run(d.id, provider.id); // THE-531: retire any superseded-model row for this chunk
      if (hasVec) upsertVec(db, d.id, vec, { vaultId, path: plan.path, model: provider.id });
    } else {
      const { resolved } = copyDedupVectors(
        db,
        {
          targetId: d.id,
          bodySha: d.bodySha,
          contentHash: d.contentHash,
          vaultId,
          path: plan.path,
          model: provider.id,
          ts: plan.ts,
          hasVec,
          hasChunkSparse,
          hasChunkColbert,
        },
        dedupCache,
      );
      if (!resolved) dedupUnresolved += 1;
    }
    // THE-406: BM25 matches on the same text the dense vector embeds (enriched when the flag is
    // on); bm25Chunks JOINs chunks for the raw display content, so search output is unchanged.
    //
    // THE-711 follow-up: the rowid is READ BACK rather than taken from the upsert. `upChunk` is an
    // ON CONFLICT DO UPDATE, so this is an insert on a new chunk and an update on an existing one,
    // and only the insert case would have a meaningful lastInsertRowid — using it would bind the
    // FTS entry to the wrong chunk on every re-index of unchanged content. `id` is the PRIMARY
    // KEY, so this is an index seek.
    if (hasChunkFts) {
      const rid = rowidOf.get(d.id) as { rowid: number } | undefined;
      if (rid) upsertChunkFtsRow(db, rid.rowid, d.embedText ?? d.content);
    }
    // THE-395: an empty head (the serving runtime could not produce it) is skipped, not stored —
    // an all-empty chunk_sparse / chunk_colbert would only bloat scans with dead rows.
    const sp = plan.sparse?.[i];
    if (!d.skipEmbed && hasChunkSparse && sp && Object.keys(sp).length > 0)
      upsertChunkSparse(db, d.id, vaultId, sp);
    const cb = plan.colbert?.[i];
    if (!d.skipEmbed && hasChunkColbert && cb && cb.length > 0)
      upsertChunkColbert(db, d.id, vaultId, cb);
  });
  return { upserted: plan.toEmbed.length, deleted, dedupUnresolved };
}

// Notify the index hook of a committed plan's (re)embedded chunks. Call only AFTER the plan's
// transaction has committed, so a consumer never observes an uncommitted (possibly rolled-back)
// chunk.
export function fireIndexHook(onIndexed: IndexHook | undefined, plan: NoteWritePlan): void {
  if (!onIndexed) return;
  // Cross-path dedup (migration 20260719_001): a skipEmbed chunk carries no NEW embedding this run,
  // so it is not reported as a (re)embedded chunk.
  const embedded = plan.toEmbed
    .map((d, i) => ({ d, vec: plan.vectors[i] ?? [] }))
    .filter((x) => !x.d.skipEmbed);
  if (embedded.length > 0) {
    onIndexed(
      embedded.map(({ d, vec }) => ({
        id: d.id,
        path: plan.path,
        content: d.content,
        embedding: vec,
      })),
    );
  }
}
