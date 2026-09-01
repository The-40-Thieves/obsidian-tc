// WP3 slice 1 (docs/plans/2026-07-30-codebase-refactor-map.md): types only — no runtime code
// belongs here, and nothing here may import indexer.ts (the facade), note-plan.ts, or
// embed-batches.ts. Moved verbatim out of indexer.ts.
import type { WriteTxnHooks } from "../../db/txn";
import type { Database } from "../../db/types";
import type { EmbeddingProvider } from "../../embeddings";
import type { chunkNote } from "../chunk";
import type { ColbertMatrix } from "../colbert";
import type { RepresentationManifest } from "../representation";
import type { SparseVec } from "../sparse";
import type { VecRebuildEvent } from "../vec";

export interface IndexStats {
  notes_seen: number;
  notes_indexed: number;
  chunks_upserted: number;
  chunks_deleted: number;
  chunks_unchanged: number;
  edges_inserted: number;
  edges_deleted: number;
  secrets_skipped: number;
  vec_enabled: boolean;
  /** THE-291 (additive): FTS5 availability + notes-metadata write counts. */
  fts_enabled: boolean;
  notes_upserted: number;
  notes_deleted: number;
  /** THE-390 (additive): notes skipped this pass because the embed provider rejected one of
   *  their chunks even as a single-text request; retried automatically next reconcile. */
  notes_embed_failed: number;
  /** THE-499: chunks whose embedding was reused from an identical-body sibling this pass (dedup),
   *  aggregated instead of logged per-chunk. */
  chunks_dedup_reused: number;
  /** THE-588: the LOSS side of dedup — a chunk was skipped for embedding (its body matched an
   *  already-seen sibling) but that sibling had no stored vector to copy (e.g. the owner's note was
   *  quarantined this pass, see notes_embed_failed). The chunk row is still written, but it carries
   *  no dense/sparse/colbert vector this pass and stays FTS-only until the owner re-embeds — see
   *  copyDedupVectors' `!src` bail. Unlike chunks_dedup_reused, a rise here is BAD: it is retrieval
   *  coverage lost, not work avoided. */
  chunks_dedup_unresolved: number;
  /** THE-507 (additive): embed requests the provider rejected for exceeding its context (HTTP
   *  400/413) and that were bisected + retried this pass. Already reported on stderr; surfaced here
   *  so the caller can emit it as a counter without the indexer taking a telemetry dependency. */
  embed_batch_rejections: number;
  /** THE-925 (additive): notes whose batched plan was skipped this pass because a concurrent
   *  index-on-write commit (write_note / the vault watcher, via IndexCoordinator -> indexNote on
   *  the same cache.db connection) changed the path's chunks after the plan was computed —
   *  see index-vault.ts's freshness guard. Already reported on stderr (sampled); surfaced here so
   *  the caller can emit it as a counter, matching notes_embed_failed/embed_batch_rejections above.
   *  Non-zero is rare and expected under concurrent write traffic; the skipped note is re-planned
   *  against current content on the next index_vault pass, never silently lost. */
  notes_stale_skipped: number;
  model: string;
  dimensions: number;
}

/** A chunk that was (re)embedded this pass; handed to the optional index hook. */
export interface IndexedChunk {
  id: string;
  path: string;
  content: string;
  embedding: number[];
}

/** THE-233 W-INGEST seam: notified of newly-embedded chunks. W-WORKERS wires the
 *  contradiction-check enqueue here at integration; default is no hook. */
export type IndexHook = (chunks: IndexedChunk[]) => void;

export interface ExistingRow {
  /** THE-711 follow-up: the chunks rowid. chunk_fts is contentless and can only be deleted from by
   *  rowid, and that mapping dies with the chunks row — so the delete path must carry it in rather
   *  than look it up after the fact. Selected in both preloadChunkState and the per-path fallback. */
  rowid: number;
  id: string;
  content_hash: string;
  /** THE-531: the model of this chunk's ACTIVE embedding, or null when it has none. A mismatch with
   *  the current provider forces a re-embed even when content_hash is unchanged. */
  active_model: string | null;
}

// A note's chunk after secret-gating, carrying its stable chunk id. embedText (THE-406) is the
// context-enriched text that is embedded + BM25-indexed INSTEAD of content when
// embeddings.chunkContext is on; content stays the raw display text everywhere.
// bodySha is contentHash() over the RAW body (c.content, PRE-enrichment) — the cross-path
// dedup key; skipEmbed marks a chunk whose identical body was already embedded at another path
// this run, so it is STORED but its embedding is reused/skipped (migration 20260719_001).
export type PlannedChunk = ReturnType<typeof chunkNote>[number] & {
  id: string;
  embedText?: string;
  bodySha: string;
  skipEmbed?: boolean;
};

// A note's pending writes, computed (including the embed() network call) WITHOUT touching the
// database or opening a transaction, so many plans can be applied inside one transaction.
export interface NoteWritePlan {
  path: string;
  existing: ExistingRow[];
  desiredIds: Set<string>;
  toEmbed: PlannedChunk[];
  vectors: number[][];
  /** THE-388: filled by embedPlans only when the provider emits embedFull() (bge-m3), parallel to
   *  vectors; written to chunk_sparse / chunk_colbert. Absent for dense-only providers. */
  sparse?: SparseVec[];
  colbert?: ColbertMatrix[];
  ts: number;
}

export interface PlanResult {
  plan: NoteWritePlan | null;
  unchanged: number;
  secretsSkipped: number;
  /** THE-291: secret-flagged chunk contents, excised from the note's FTS copy. */
  flagged: string[];
  /** THE-499: number of chunks in this note whose embedding was dedup-reused from a sibling path. */
  dedupSkipped: number;
}

/** THE-390: outcome of an embedPlans pass. `failed` lists plans with at least one chunk the
 *  provider rejected even as a single-text request (HTTP 400/413); their vectors are NOT
 *  populated and they must not be applied — the content-hash skip retries them next reconcile.
 *  `rejections` counts rejected requests that were bisected + retried (an operator signal that
 *  `embeddings.maxBatchTokens` sits over the provider context and the pass is paying retries). */
export interface EmbedReport {
  failed: NoteWritePlan[];
  rejections: number;
}

// THE-454: copy an identical EMBED TEXT's already-stored vectors onto a cross-path-dedup (skipEmbed)
// chunk so it stays retrievable by dense/sparse/ColBERT, not just FTS. See indexer.ts's
// copyDedupVectors/fetchDedupSource for the read/write logic that produces and consumes this.
/** THE-488: the source vectors for a dedup copy, keyed by content_hash. `null` caches a MISS (the
 *  owner had no stored embedding) so a duplicate-heavy flush never re-queries a known-absent source. */
export type DedupSource = {
  embedding: Uint8Array;
  dimensions: number;
  sparse: string | null;
  colbert: string | null;
} | null;
export type DedupCache = Map<string, DedupSource>;

export interface IndexVaultArgs {
  db: Database;
  provider: EmbeddingProvider;
  vaultId: string;
  root: string;
  sub?: string;
  isReadable: (rel: string) => boolean;
  now?: () => number;
  onIndexed?: IndexHook;
  /** GH #171/#172: embed-batch tuning; each field falls back to its module default. Callers thread
   *  config.embeddings.{batchSize,concurrency,maxBatchTokens} here so a slow or small local runner
   *  can be tuned without touching code. */
  embed?: { batchSize?: number; concurrency?: number; maxBatchTokens?: number };
  /** THE-406: embeddings.chunkContext — embed + BM25-index each chunk with a note-title +
   *  heading-breadcrumb prefix (display content stays raw). Callers MUST thread the same value on
   *  every index path (boot reconcile, index_vault tool, index-on-write): the chunk content hash
   *  covers the enriched text, so mixed values would re-embed the same chunks back and forth. */
  chunkContext?: boolean;
  /** THE-424: indexing.chunkTokens — the chunker's token budget for this pass. Undefined -> the
   *  chunker's DEFAULT_CHUNK_TOKENS (512), i.e. the pre-THE-424 behaviour. Must agree with the
   *  chunkTokens folded into `representationManifest` below: they describe the same pass, and a
   *  disagreement would index at one budget while fingerprinting as another. */
  chunkTokens?: number;
  /** THE-683: the representation identity of the index this pass writes into, built ONCE by the
   *  caller with `buildRepresentationManifest`. Required, and deliberately not defaulted: this used
   *  to be re-derived here from loose fields (`chunkContext`, `revision`) that had to match
   *  runtime/indexing-wiring.ts exactly, and a mismatch means boot and index_vault each DROP and
   *  rebuild the table the other just built — an unbounded rebuild loop. Passing the built manifest
   *  makes that divergence unrepresentable. Note `chunkContext` above stays: the chunker consumes it
   *  for text enrichment, which is a separate consumer from the fingerprint. */
  representation: RepresentationManifest;
  /** Graph densification (docs/plans/2026-07-13-graph-densification.md): build derived edges during
   *  index_vault. tagEdges = shared-frontmatter-tag co-occurrence; knnEdges = vec0 kNN neighbors.
   *  Off unless threaded from config.retrieval.densify. Full-state per kind (toggling off prunes). */
  densify?: {
    tagEdges?: boolean;
    knnEdges?: boolean;
    knnK?: number;
    knnMinSim?: number;
    maxTagFanout?: number;
  };
  /** THE-291: fires when the notes/FTS metadata pass has committed (independent of embed
   *  success), so the caller can flip metadata readiness even if the embed pass later fails. */
  onNotesPass?: () => void;
  /** THE-500: bound each write transaction by BOTH note count and accumulated raw bytes, so a batch
   *  of large notes cannot make one oversized transaction. Each falls back to its default
   *  (maxNotes 100, maxBytes 8 MiB). Embedding always runs OUTSIDE the write txn regardless. */
  batch?: { maxNotes?: number; maxBytes?: number };
  /** THE-490: opt-in streaming walk. OFF by default — the default path is byte-for-byte the
   *  pre-THE-490 behavior (walkVault's full sorted array, materialized before any note is
   *  processed). When true, indexVault instead consumes walkVaultStream's async generator:
   *  entries are only sorted WITHIN one directory (not across the whole tree), so peak walk
   *  memory is bounded by the largest single directory rather than the total file count, and
   *  note processing (parse/plan/batch) for the first entries begins before the rest of the tree
   *  has been read. Verified order-independent for index OUTPUT (not for internal ordering/stats)
   *  in test/index-stream-walk-equivalence.test.ts: every downstream consumer of walk order
   *  (the content-hash dedup registry, the wikilink/tag/kNN edge reconcilers) already normalizes
   *  via a Set, a full internal sort, or a full-state DB reconcile before anything is written or
   *  compared, so a non-globally-sorted traversal produces an IDENTICAL final DB state. Left
   *  default-off anyway, per THE-490's instruction to keep the existing path the default. */
  walk?: { streaming?: boolean };
  /** THE-585 (#5) / THE-612: write-lock + vec-rebuild hooks. Additive/best-effort, threaded from
   *  the composition root — the only place that knows a MetricsRecorder exists. */
  sql?: WriteTxnHooks;
  onVecRebuild?: (e: VecRebuildEvent) => void;
  /** THE-645: fired once per completed flush() batch (never per-chunk — see index-vault.ts's
   *  perf-gate note; `index.chunks_per_s` is a gated metric this must not cost anything on the
   *  common absent-callback path), so a poller can observe progress on a long-running pass without
   *  the per-chunk cost. Absent -> no in-flight tracking. */
  onProgress?: (progress: {
    /** Walk total, known up front (default eager walk) or -1 when `walk.streaming` is true (the
     *  eager total isn't known ahead of time on that path — see THE-490's comment above). */
    notesSeen: number;
    /** Cumulative notes indexed (had an actual chunk write) across flushes so far this pass. */
    notesProcessed: number;
    /** Cumulative chunks upserted across flushes so far this pass. */
    chunksUpserted: number;
    /** epoch ms this indexVault call started, for an elapsed/ETA computation by the reader. */
    startedAt: number;
  }) => void;
}
