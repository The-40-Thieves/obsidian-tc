// THE-465: shared types for the staged graph-search pipeline. GraphSearchOptions/GraphSearchResult/
// FusionMode/Candidate/ChunkEmbRow moved out of graph_search.ts verbatim (no field changes) so every
// stage module can share them without a dependency cycle back on graph_search.ts itself.
// graph_search.ts re-exports GraphSearchOptions/GraphSearchResult/FusionMode so the public import
// path (`from "./graph_search"` / `from "../../search/graph_search"`) is unchanged for callers.
import type { ColbertMatrix } from "../colbert";
import type { Reranker } from "../rerank";
import type { SparseVec } from "../sparse";
import type { OnStageMetric } from "./instrumentation";

// THE-398: "convex" fuses per-query min-max-NORMALIZED raw stream scores instead of ranks (Bruch
// et al., arXiv:2210.11934) — it preserves the dense model's confidence margins where RRF sees
// only rank positions. Same downstream pipeline as graph_rrf (diversification, gated rerank).
export type FusionMode = "graph_rrf" | "rrf_rerank" | "score_merge" | "convex";

export interface GraphSearchResult {
  chunk_id: string;
  path: string;
  content?: string;
  source: "seed" | "expansion" | "lexical" | "sparse" | "temporal";
  hop: number;
  via_edge: { type: string; source_path: string; provenance: string | null } | null;
  root_seed: string | null;
  rerank_score: number;
}

export interface GraphSearchOptions {
  query: string;
  queryVec: number[];
  vaultId: string;
  /** THE-530: the active embedding model, threaded to the vector-seed scan so the brute-force
   *  fallback never scores a superseded-model vector against this query. Omitted -> no filter. */
  model?: string;
  seedCount?: number;
  finalTopK?: number;
  /** THE-459 (additive, observability-only): fired once per retrieval stage with its candidate
   *  count. Default undefined -> no behavior change. Kept unchanged by THE-465 — see
   *  `onStageMetric` below for the formalized typed per-stage record. */
  onStage?: (stage: string, count: number) => void;
  /** THE-465 (additive, observability-only): fired once per named pipeline stage with a typed
   *  {stage, candidatesIn, candidatesOut, durationMs} record. Default undefined -> no behavior
   *  change. Independent of `onStage` — both may be supplied together. */
  onStageMetric?: OnStageMetric;
  maxExpansionChunks?: number;
  hopLimit?: number;
  similarityThreshold?: number;
  /** Graph densification (docs/plans/2026-07-13-graph-densification.md): traverse derived edges
   *  (kNN similar_to, shared_tag) in the walk, down-weighted vs authored links. Off by default. */
  densify?: { includeInWalk?: boolean; derivedWeight?: number };
  fusionMode?: FusionMode;
  rrfK?: number;
  rerankPool?: number;
  /** THE-391: adaptive per-query RRF stream weighting. When enabled, the query's lexical
   *  specificity (mean IDF of its terms over chunk_fts, tokenizer-aligned — see adaptive_rrf.ts)
   *  tilts the fusion: rare/specific terms upweight the BM25 + learned-sparse streams, common
   *  conceptual queries upweight the SEMANTIC side — the dense seeds AND the graph expansion
   *  together, so the tilt reweights the lexical-vs-semantic axis without ever distorting the
   *  seed-vs-expansion balance (measured on the live index: pinning expansion at 1 while seeds
   *  moved cost multi-hop recall, because multi-hop targets ride the expansion stream). Exactly
   *  static RRF when disabled (default), when the signal is unavailable (no FTS5 / empty corpus /
   *  no term in corpus), or at specificity 0.5. `gain` bounds the tilt: stream weights stay
   *  within [1-gain, 1+gain] (default 0.5). */
  adaptiveRrf?: { enabled?: boolean; gain?: number };
  /** THE-73: chunk-level BM25 lexical stream fused into the RRF (third stream). Defaults on;
   *  no-ops when chunk_fts is absent (FTS-less adapter / un-provisioned index). `count` defaults
   *  to seedCount. */
  lexical?: { enabled?: boolean; count?: number };
  /** THE-388: bge-m3 learned-sparse stream fused into the RRF (parallel to the lexical stream).
   *  Runs only when `querySparse` (the query's bge-m3 lexical_weights) is supplied AND chunk_sparse
   *  holds data; no-op otherwise. `sparseCount` defaults to seedCount. */
  querySparse?: SparseVec;
  sparseCount?: number;
  /** THE-388: ColBERT late-interaction rerank of the fused top-K. Runs only when the query's
   *  ColBERT matrix is supplied AND chunk_colbert holds data; a no-op otherwise. */
  queryColbert?: ColbertMatrix;
  colbertPool?: number;
  /** THE-73 Phase 2: cap how many chunks per cluster_id reach the final result (KMeans
   *  diversification). Off when unset/0; chunks with a NULL cluster_id (unclustered) are never
   *  capped. Populate cluster_id offline via `obsidian-tc cluster`. graph_rrf mode only. */
  maxPerCluster?: number;
  /** THE-393: graph expansion as a CAPPED auxiliary stream. When enabled, expansion walks only
   *  the top `expansionSeeds` seed notes (default 8), keeps at most `perSeedCap` expansion
   *  chunks per root seed (default 3), and drops expansion candidates that are hub notes —
   *  degree in vault_edges above `hubDegreeCap` (default 40; index/dashboard/audit pages are
   *  exactly the high-degree offenders) — so a weak or high-degree seed cannot flood the fused
   *  ranking ("hub drift" / structural flooding). Off by default: the expansion stream keeps
   *  its historical shape (all seed paths, total cap only). */
  graphStream?: {
    enabled?: boolean;
    expansionSeeds?: number;
    perSeedCap?: number;
    hubDegreeCap?: number;
  };
  /** THE-401: smooth expansion scoring — replaces the lexicographic hop-then-cosine stream order
   *  (which asserts cosine-0.05@1-hop > cosine-0.99@2-hop) and the hard hubDegreeCap drop (a
   *  Heaviside step measured to cost bridge recall 0.7→0.4 at cap 40) with one continuous score:
   *  S = cos(v,q) · lambda^(hop−1) · 1/(1 + (deg/hubMu)^hubGamma). Defaults tuned for THIS vault:
   *  lambda 0.8; hubMu 75 (inflection between legitimate bridges at degree 58–72 and noise hubs at
   *  80–157); hubGamma 6 — a deg-65 bridge keeps ~×0.70 while a deg-110 audit hub gets ~×0.09.
   *  Composes with graphStream (frontier + per-seed caps still apply) but REPLACES its hard
   *  degree drop. Composes multiplicatively with Ebbinghaus decay. Off by default. */
  smoothExpansion?: { enabled?: boolean; lambda?: number; hubMu?: number; hubGamma?: number };
  /** THE-393: post-fusion diversification (graph_rrf mode only — the reranker modes own their
   *  final order). `maxPerNote` collapses the fused list to at most that many chunks per note
   *  BEFORE the final cut, so one long note cannot fill the top-K (results are path-grained
   *  downstream). `mmr` re-picks the final K by Maximal Marginal Relevance over the fused pool:
   *  relevance = min-max-normalized RRF score, redundancy = max cosine to an already-picked
   *  chunk, balanced by `lambda` (default 0.7; 1 = pure relevance, 0 = pure diversity). Both
   *  off by default. */
  diversify?: { maxPerNote?: number; mmr?: { enabled?: boolean; lambda?: number } };
  /** THE-394: gated cross-encoder rerank for graph_rrf. Reranking every query costs a model
   *  round-trip, and (measured at n=32) the RRF order is already strong on easy queries — so the
   *  reranker fires ONLY on hard ones: the seed-strength router did not fire AND the top-1 seed
   *  cosine sits below `hardTop1` (default 0.55). On a hard query the top `pool` (default 20)
   *  fused candidates are reranked through opts.reranker (the gateway /rerank seam; graceful
   *  no-op fallback preserves the RRF order on absence/error) and the remainder keeps its RRF
   *  order below them. Easy queries never pay the call. Off by default. */
  gatedRerank?: {
    enabled?: boolean;
    hardTop1?: number;
    /** THE-400: when set, hardness is `z-margin < hardZ` (top-1 z-score over the seed-cosine
     *  pool) instead of the absolute `top1 < hardTop1` cosine rule — absolute cosine thresholds
     *  do not transfer across embedding models (the 0.55 gate fired 0/32 on nomic); the z-margin
     *  is distribution-relative and model-agnostic. */
    hardZ?: number;
    pool?: number;
  };
  /** THE-73 Phase 3: Ebbinghaus recency weight on the expansion stream — each expansion chunk's
   *  ordering score is multiplied by exp(-lambda * days_since_modified) from notes.mtime, so a stale
   *  hub note loses expansion priority. Off unless enabled; the similarity gate still uses raw
   *  cosine, so decay only reorders/cuts, never drops a chunk below similarityThreshold. lambda
   *  defaults to a ~139-day half-life; nowMs is injectable for deterministic tests. */
  decay?: { enabled?: boolean; lambda?: number; nowMs?: number };
  /** Config-driven frontmatter metadata prior (authority boost), ported from the retired
   *  KMS/vault-sync hardcoded prior (009_vault_search_priority.sql). Applied POST-FUSION (after RRF /
   *  convex, before the final sort): each candidate's fused score gains Σ(boost) over the rules whose
   *  note frontmatter[field]===value, then the pool re-sorts — composing ADDITIVELY with the
   *  expansion decay above. The per-candidate |Σboost| is CLAMPED to `clampFraction` (default 0.5)
   *  of the per-query fused-score spread, so the prior is SUB-DOMINANT to the RRF signal: a
   *  tie-break, never an override. Off by default (empty rules or disabled = exact no-op). */
  metadataPrior?: {
    enabled?: boolean;
    rules?: Array<{ field: string; value: string; boost: number }>;
    clampFraction?: number;
  };
  /** Seed-strength router. Default rule: top-1 cosine ≥ simThreshold AND top1−top4 ≥ margin ⇒
   *  skip expansion. THE-400: when `zThreshold` is set the rule becomes `z-margin ≥ zThreshold`
   *  (top-1 z-score over the whole seed-cosine pool) — model-agnostic where absolute cosine
   *  thresholds are not. */
  router?: { enabled?: boolean; simThreshold?: number; margin?: number; zThreshold?: number };
  /** THE-398: convex-combination fusion tuning (fusionMode "convex" only). `alpha` weighs the
   *  SEMANTIC side (dense seeds + graph expansion) against the LEXICAL side (BM25 + learned
   *  sparse): score = alpha·(seedNorm+expNorm) + (1−alpha)·(bm25Norm+sparseNorm), each stream
   *  min-max normalized over its own per-query pool, absent streams contributing 0. Default 0.7.
   *  adaptiveRrf's per-stream tilt is RRF-specific and does not apply in convex mode. */
  convex?: { alpha?: number };
  /** THE-221 Phase 1: conditional temporal stream. When enabled AND the query carries an explicit
   *  temporal constraint (precision-first parser: prepositioned months/years, ISO dates,
   *  early/mid/late-month, relative forms — see temporal.ts), chunks of notes whose FILENAME date
   *  falls inside the parsed range join the fusion as a stream ranked by proximity to the range
   *  midpoint. Empty on non-temporal queries — exactly the static configuration. `count` caps the
   *  stream (default seedCount); `nowMs` is injectable for deterministic tests. Off by default. */
  temporal?: { enabled?: boolean; count?: number; nowMs?: number };
  reranker?: Reranker | null;
  isReadable?: (path: string) => boolean;
  /** cached_activation_score lookup from vault_object_state (W-SCHEMA); inert when absent. */
  activationFor?: (chunkId: string) => number | null | undefined;
  /** THE-233: bubble-safe activation composition. STRICTLY OFF BY DEFAULT and non-behavioral
   *  when disabled — even with activationFor present, the fused order is returned untouched. When
   *  `enabled` AND activationFor is provided, the activation signal folds into the fused order as a
   *  bounded multiplier (1 + (activation-0.5)*k) and a SINGLE bubble pass reorders it, so every
   *  item shifts by at most ONE position (provable one-adjacent-swap-per-item worst case). `k`
   *  tunes the multiplier range (default ACTIVATION_MULTIPLIER_RANGE). Mirrors opts.decay's
   *  off-by-default shape. NOTE: the same bubbleSafeRerank primitive also composes a metadata-prior
   *  signal (separate PR); here it is wired only to the existing activation signal. */
  bubbleSafe?: { enabled?: boolean; k?: number };
}

/** One retrieval candidate as it flows through the pipeline, before final projection to
 *  GraphSearchResult. Identical shape to the pre-THE-465 inline `Candidate` interface. */
export interface Candidate {
  chunk_id: string;
  path: string;
  content: string;
  source: "seed" | "expansion" | "lexical" | "sparse" | "temporal";
  hop: number;
  via_edge: { type: string; source_path: string; provenance: string | null } | null;
  root_seed: string | null;
  streamRank: number;
}

export interface ChunkEmbRow {
  id: string;
  path: string;
  content: string;
  embedding: Uint8Array;
}

// THE-73 Phase 3: default Ebbinghaus decay rate per day for the expansion stream. exp(-0.005*days)
// is a ~139-day half-life — gentle enough that a note stays retrievable for months, steep enough
// that a years-stale hub loses expansion priority. Tunable via opts.decay.lambda.
export const DEFAULT_DECAY_LAMBDA = 0.005;
export const MS_PER_DAY = 86_400_000;
// Metadata-prior sub-dominance guard: cap |Σboost| per candidate at this fraction of the per-query
// fused-score spread. <1 keeps the prior a tie-break — even a fully-boosted bottom candidate cannot
// overtake the top base-scored one (see clampMetadataBoost).
export const DEFAULT_META_PRIOR_CLAMP = 0.5;
