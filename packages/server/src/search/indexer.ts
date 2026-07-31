// Chunk-store writer: turns notes into persisted chunks + embeddings, and keeps
// the store incremental. A chunk's id is stable for a (vault, path, position), so
// re-indexing skips chunks whose content hash is unchanged, re-embeds changed
// ones, and prunes chunks that no longer exist in the note. chunk_embeddings is
// deleted explicitly (not relying on FK cascade, which node:sqlite tests run with
// foreign_keys off). vec_chunks is kept in lock-step only when the extension loaded.
//
// WP3 (docs/plans/2026-07-30-codebase-refactor-map.md): this file is now a PURE compatibility
// facade over ./indexing/* — no function/const bodies live here, only imports and re-exports, so
// every name this file ever exported is still exported from here and no consumer needs to change
// its import path.
//
// slice 1: the READ-ONLY planning phase (chunkId, estimateEmbedTokens, preloadChunkState,
// computeNotePlan, hasBodyShaColumn, hasDerivedEdgeColumns, readNoteTags) lives in
// indexing/note-plan.ts; the external-provider phase (isEmbedRejection, embedSubBatch, embedPlans)
// lives in indexing/embed-batches.ts; the shared types (IndexStats, IndexedChunk, IndexHook,
// EmbedReport, DedupCache, IndexVaultArgs, and the internal plan/row types those need) live in
// indexing/types.ts.
//
// slice 2: the cross-path dedup lookup/copy (fetchDedupSource, copyDedupVectors) lives in
// indexing/dedup.ts; the transactional SQL-application phase (applyNoteWrites, fireIndexHook,
// DELETE_CONTRADICTIONS_SQL) lives in indexing/persist-note-plan.ts. Both execute INSIDE the
// caller's existing write transaction and make no embedding calls.
//
// slice 3: the orchestrators — indexNote/deindexNote (single-note; indexing/index-note.ts) and
// indexVault, which does whole-vault batching (indexing/index-vault.ts) — own the transaction
// boundary (BEGIN/COMMIT/ROLLBACK via inWriteTransaction) that applyNoteWrites and copyDedupVectors
// execute inside of. See indexing/index-note.ts / indexing/index-vault.ts for that invariant's detail.
export { enrichChunkText } from "./chunk";
// indexing/embed-batches.ts: the external-provider phase.
export { embedPlans } from "./indexing/embed-batches";
// indexing/index-note.ts: single-note orchestration + the index hook firing.
export { deindexNote, indexNote } from "./indexing/index-note";
// indexing/index-vault.ts: whole-vault orchestration (walk, batching, stale-note cleanup, edge
// reconciliation, aggregated stats).
export { indexVault } from "./indexing/index-vault";
// indexing/note-plan.ts: the READ-ONLY planning phase.
export {
  chunkId,
  estimateEmbedTokens,
  hasBodyShaColumn,
  hasDerivedEdgeColumns,
  preloadChunkState,
  readNoteTags,
} from "./indexing/note-plan";
// indexing/types.ts: the shared IndexStats/IndexedChunk/IndexHook/EmbedReport/DedupCache/
// IndexVaultArgs surface, plus the internal plan/row types persistence and orchestration below
// still need.
export type {
  DedupCache,
  EmbedReport,
  IndexedChunk,
  IndexHook,
  IndexStats,
  IndexVaultArgs,
} from "./indexing/types";
