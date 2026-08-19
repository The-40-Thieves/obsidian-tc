// THE-465: shared types for the staged graph-search pipeline. GraphSearchOptions/GraphSearchResult/
// FusionMode/Candidate/ChunkEmbRow moved out of graph_search.ts verbatim (no field changes) so every
// stage module can share them without a dependency cycle back on graph_search.ts itself.
// graph_search.ts re-exports GraphSearchOptions/GraphSearchResult/FusionMode so the public import
// path (`from "./graph_search"` / `from "../../search/graph_search"`) is unchanged for callers.
import type { RetrievalConfidence, ScoreCalibration } from "../../experiential/calibration";
import type { ColbertMatrix } from "../colbert";
import type { OnRerankOutcome, Reranker } from "../rerank";
import type { SparseVec } from "../sparse";
import type { OnRetrievalTrace, OnStageMetric } from "./instrumentation";

// THE-398: "convex" fuses per-query min-max-NORMALIZED raw stream scores instead of ranks (Bruch
// et al., arXiv:2210.11934) — it preserves the dense model's confidence margins where RRF sees
// only rank positions. Same downstream pipeline as graph_rrf (diversification, gated rerank).
export type FusionMode = "graph_rrf" | "rrf_rerank" | "score_merge" | "convex";

export interface GraphSearchResult {
  chunk_id: string;
  path: string;
  content?: string;
  // THE-628 (first PR): "summary" mirrors Candidate["source"] below — see that field's comment.
  // THE-628 (second PR): "cluster_summary" is the tier-2 (RAPTOR cluster) analogue — see
  // Candidate["source"]'s comment for why it is a DISTINCT source from "summary".
  source: "seed" | "expansion" | "lexical" | "sparse" | "temporal" | "summary" | "cluster_summary";
  hop: number;
  via_edge: { type: string; source_path: string; provenance: string | null } | null;
  root_seed: string | null;
  rerank_score: number;
}

/** THE-631: an ADDITIVE, non-ranking-affecting coverage/confidence estimate for one graphSearch()
 *  call — see graph_search.ts's estimateCoverage() for exactly how each field is computed and why
 *  it is honest rather than a fabricated 0-1 score. Reported via GraphSearchOptions.onCoverage. */
export interface CoverageEstimate {
  /** GraphSearchResult.source values actually present in the returned set — observed from the
   *  results themselves, not from which streams were merely enabled. */
  arms: Array<"seed" | "expansion" | "lexical" | "sparse" | "temporal">;
  armsContributed: number;
  /** Size of the full source taxonomy (5) — the denominator for armsContributed. */
  armsPossible: number;
  /** The seed-strength router (classify.ts) judged the seeds strong enough and skipped graph
   *  expansion outright — zero expansion arm here is a deliberate decision, not a coverage gap. */
  expansionSkipped: boolean;
  /** Expansion ran and found more qualifying candidates than maxExpansionChunks / a per-seed cap
   *  kept — a genuine coverage gap, distinct from expansionSkipped. */
  expansionTruncated: boolean;
  /** opts.finalTopK (or its default) — how many results the caller asked for. */
  requested: number;
  /** results.length actually returned. */
  returned: number;
  /** returned < requested: the pipeline could not fill the requested page. Not a ranking
   *  judgment — just an honest count. */
  underfilled: boolean;
  /** THE-631 item 2 — how many DISTINCT returned notes have an mtime older than
   *  `staleThresholdDays`. Content age, from `notes.mtime`, via the same THE-450 helpers the m2
   *  search tools stamp `age_days`/`stale` with, so there is exactly one definition of stale in
   *  the codebase. Counted per NOTE, not per chunk: three chunks of one stale note is one stale
   *  note, otherwise the number tracks chunking granularity rather than the vault. */
  staleReturned: number;
  /** Returned notes with NO `notes` row, so their age is UNKNOWN — never folded into
   *  `staleReturned`. A pruned or unindexed note is not evidence of freshness, and "absent" must
   *  stay distinguishable from "fresh" at the read surface. */
  staleUnknown: number;
  /** THE-631 item 1 / THE-733 — where this query's top fused score falls in the VAULT'S OWN
   *  calibrated distribution. A discriminated result: an uncalibrated vault reports
   *  `available: false` with a reason rather than a number derived from a global constant.
   *
   *  That is the whole point. A fused RRF score is not comparable across vaults, so the only
   *  number otherwise reachable here is `DEFAULT_GAP_THRESHOLD` — an n=136 calibration on one
   *  vault — and THE-631 condemned using it in advance: "a confidence number computed from
   *  another vault's percentiles is worse than no confidence number, because it looks
   *  authoritative." Absent and low are different claims and are reported differently. */
  confidence: RetrievalConfidence;
  /** The threshold `staleReturned` was computed against, so the count is interpretable without
   *  knowing the server's configuration. */
  staleThresholdDays: number;
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
  /** THE-585 (#7, #8, additive, observability-only): forwarded to semanticSearch's `onFallback`,
   *  fired when the seed stage abandons the vec0 index for the brute-force scan. Default undefined
   *  -> no behavior change. Lives here because the seed stage is where most production searches
   *  touch vec0, so a fallback counter that skipped it would miss the common case. */
  onVecFallback?: (reason: "error" | "underfill") => void;
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
  /** THE-628 (first PR): the note-level summary candidate stream (search/note-summaries.ts),
   *  fused into RRF as the "summary" source. DARK by default (retrieval.summaries.enabled): when
   *  unset/false, graph_search.ts never queries note_summaries at all — no candidates, no `source:
   *  "summary"` results, byte-identical to today. ACL-filtered by the SAME `isReadable` every
   *  other stream uses (candidate_assembly.ts), so a summary whose source note the caller cannot
   *  read is excluded exactly as the chunk would be. */
  /** THE-628 (second PR): `clusters.enabled` additionally activates the tier-2 (RAPTOR cluster)
   *  candidate stream (search/cluster-summaries.ts), fused as the "cluster_summary" source. DARK
   *  by the SAME contract as note-level `enabled` above — unset/false means graph_search.ts never
   *  queries cluster_summaries. Deliberately a NESTED, independent flag rather than reusing
   *  `enabled`: a cluster summary's ACL check spans MULTIPLE notes (see search/cluster-summaries.ts
   *  searchClusterSummaries), a materially different — and more restrictive — leak surface than a
   *  single-note summary, so an operator can turn on tier-1 without automatically inheriting
   *  tier-2's broader mixed-ACL exposure. */
  summaries?: { enabled?: boolean; clusters?: { enabled?: boolean } };
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
  /** THE-695/THE-852: filter the graph WALK by the caller's permitted-path set, so an unreadable
   *  note cannot serve as a bridge between two readable ones. Wired into every M7 surface and
   *  defaulted ON by `buildGraphSearchOptions` (retrieval-runtime.ts's `resolveAclWalkFilter`) —
   *  no longer a config-gated knob; pruning bridges IS the fix, not an evaluated tradeoff.
   *  Evaluated jointly with THE-693's hubDegreeCap because both land in graph_expansion.ts and
   *  `nodeDegrees` is itself computed with NO ACL — so the hub defence prunes using degrees
   *  counted over nodes the caller may not be able to read. */
  aclWalkFilter?: {
    enabled?: boolean;
    /** THE-852 fail-closed signal: true when the caller is RESTRICTED (readEnumerationUnrestricted
     *  is false) and `ensureAclPathSet` could not resolve a permitted-path set (pre-migration db,
     *  read-only handle, empty readable set). `aclSetId` is absent in this case — there is nothing
     *  to join on — so `enabled: true` alone would mean "run the walk unfiltered", reopening both
     *  THE-852 defects. `blocked: true` tells graph_expansion.ts's expandGraph to skip the walk
     *  entirely instead (seeds/lexical/sparse arms are unaffected), rather than silently serving
     *  the leaky unfiltered path. Never set for an unrestricted caller: for them a null resolution
     *  is harmless (there is nothing to filter), so the walk proceeds unfiltered exactly as it did
     *  before this ticket. */
    blocked?: boolean;
  };
  /** THE-695: the resolved `acl_path_members` set_id for THIS caller, from ensureAclPathSet.
   *  Absent means the substrate was unavailable (pre-migration db, read-only handle, empty set) and
   *  the existing hydrated-row filter remains the only ACL applied — i.e. today's behaviour. */
  aclSetId?: number;
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
  /** THE-538 (additive, observability-only): fired once per fused query with the per-stream RRF
   *  weights actually applied, so a logged retrieval outcome can be attributed to the ranking
   *  policy that produced it rather than to the policy someone believes was configured. Under
   *  adaptive RRF the weights are computed PER QUERY from lexical specificity, so the configured
   *  gain alone does not identify them. Default undefined -> no behavior change. */
  onFusionWeights?: (weights: {
    policyId: string;
    dense: number;
    lex: number;
    sparse: number;
  }) => void;
  /** THE-631 (additive, observability-only): fired once per completed graphSearch call with an
   *  honest coverage estimate of the RETURNED result set — see CoverageEstimate above and
   *  graph_search.ts's estimateCoverage() for exactly what it means. This is a pure reported
   *  side-channel: it MUST NOT feed back into scoring or ordering (see estimateCoverage()'s doc
   *  comment and the "pure side-channel" test in test/graph-coverage.test.ts). Default undefined
   *  -> no behavior change. Under multi-query fan-out (multi_query.ts) this fires once per
   *  variant; the last call wins, mirroring onFusionWeights' existing precedent. */
  onCoverage?: (coverage: CoverageEstimate) => void;
  /** THE-631 item 2: age in days past which a returned note counts toward
   *  `CoverageEstimate.staleReturned`. Defaults to freshness.ts's `STALE_THRESHOLD_DAYS` (365),
   *  deliberately the SAME constant the m2 search tools stamp `stale` with (THE-450) — two
   *  disagreeing definitions of "stale" in one codebase would be worse than one imperfect
   *  threshold. Overridable because the right value is a property of a vault's authoring cadence,
   *  not of the engine: measured 2026-08-04, the live vault's oldest note is 107 days old, so at
   *  the 365 default this count is 0 for every query there. Only read when onCoverage is set. */
  staleThresholdDays?: number;
  /** THE-733: the vault's persisted score calibration, read by the CALLER from experiential.db.
   *  Passed in rather than looked up here because `score_calibration` lives in the experiential
   *  store and this module only holds the authored cache db — giving the search path a second
   *  handle to satisfy a reported-only side channel would be the wrong trade. `null`/absent yields
   *  `confidence: { available: false, reason: "not_calibrated" }`, never a fabricated number. */
  scoreCalibration?: ScoreCalibration | null;
  /** Server version the running engine is, compared against the calibration's to FLAG a stale
   *  distribution. Absent means the comparison cannot be made, which reads as stale — the
   *  conservative direction. */
  engineVersion?: string;
  /** THE-632: vault-relative path to FOLLOW through the pipeline. Additive and
   *  observability-only, on the same "pure side-channel" contract as onCoverage above — it never
   *  filters, boosts, or reorders anything, and the returned results are byte-identical with and
   *  without it. Default undefined -> the tracing branches are skipped entirely, so normal search
   *  pays one `!== undefined` per stage and nothing else. Diagnostics ride the SAME pipeline
   *  rather than a parallel one, because a debug path that drifts from production answers a
   *  question about itself. */
  traceNotePath?: string;
  /** THE-632: receives one RetrievalTraceRecord per stage while `traceNotePath` is set. */
  onRetrievalTrace?: OnRetrievalTrace;
  /** additive, observability-only: fired once per rerankWithScores decision point —
   *  score_merge/rrf_rerank's direct call, and gatedRerank's call OR its policy-skip fallthrough
   *  (see rerank_stage.ts) — with WHY the returned ranking is what it is (see RerankOutcome's doc
   *  comment). Never changes the ranking or the fallback scores; same "pure side-channel" contract
   *  as onCoverage above. Default undefined -> no behavior change. */
  onRerankOutcome?: OnRerankOutcome;
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
  /** THE-628 (first PR): "summary" is a note-level summary row (search/note-summaries.ts), DARK
   *  behind retrieval.summaries.enabled — never populated when the flag is off, so this arm never
   *  appears in a default-config search. Deliberately NOT added to GraphSearchResult's coverage
   *  taxonomy (graph_search.ts's ALL_SOURCES / CoverageEstimate.armsPossible) in this first PR —
   *  see graph_search.ts's own comment on why that stays a 5-arm accounting for now.
   *  THE-628 (second PR): "cluster_summary" is a cluster-level (tier-2) summary row
   *  (search/cluster-summaries.ts), DARK behind retrieval.summaries.clusters.enabled — a SEPARATE
   *  flag from "summary" above. `path` on a cluster_summary candidate is the cluster_key, NOT a
   *  real vault path — see candidate_assembly.ts's cluster-summary merge block for why it is
   *  therefore NOT re-checked against `isReadable` there (the ACL check already ran, over every
   *  MEMBER path, inside searchClusterSummaries). */
  source: "seed" | "expansion" | "lexical" | "sparse" | "temporal" | "summary" | "cluster_summary";
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
