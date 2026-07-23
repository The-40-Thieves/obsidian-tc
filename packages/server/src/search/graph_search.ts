import type { Database } from "../db/types";
import { assembleCandidates } from "./graph_search_stages/candidate_assembly";
import { classify, seedZMargin } from "./graph_search_stages/classify";
import { applyDiversity } from "./graph_search_stages/diversity";
import { clampMetadataBoost, fuseScores } from "./graph_search_stages/fusion";
import { expandGraph } from "./graph_search_stages/graph_expansion";
import { runStage } from "./graph_search_stages/instrumentation";
import { colbertRerankResults, finalize } from "./graph_search_stages/projection";
import { applyGatedRerank } from "./graph_search_stages/rerank_stage";
import { generateSeeds } from "./graph_search_stages/seed_generation";
import {
  type Candidate,
  DEFAULT_DECAY_LAMBDA,
  type FusionMode,
  type GraphSearchOptions,
  type GraphSearchResult,
} from "./graph_search_stages/types";
import { rerankWithScores } from "./rerank";

// Public API is unchanged by THE-465: same graphSearch(db, opts) signature, same
// GraphSearchResult shape, same GraphSearchOptions surface (every opts.* default preserved) —
// re-exported here from graph_search_stages/types so every existing import path
// (`from "./graph_search"` / `from "../../search/graph_search"`) keeps working untouched.
export type { FusionMode, GraphSearchOptions, GraphSearchResult };
export { clampMetadataBoost, seedZMargin };

/**
 * GraphRAG search — THE-233 W-RETRIEVAL port of knowledge-mcp-server vault_graph_search.
 * Vector seeds (semanticSearch — obsidian-tc has no chunk-level hybrid, and "don't
 * reimplement hybrid" stands) -> seed-strength router -> literal links_to expansion ->
 * RRF fusion. Default graph_rrf (the eval winner: RRF over the seed + expansion streams
 * IS the final ranking, no reranker call, so a rank-1 seed cannot be displaced by an
 * inflated expansion score). rrf_rerank / score_merge route through the injected reranker
 * (D1 gateway passthrough at integration; graceful no-op fallback otherwise).
 *
 * THE-465: the body below is a thin orchestrator over the staged pipeline in
 * `./graph_search_stages/` — classify -> seedGeneration -> graphExpansion ->
 * candidateAssembly -> scoreFusion -> diversity -> gatedRerank -> projection. Each stage is a
 * separately-typed, separately-testable module; this function's only job is threading their
 * typed inputs/outputs together in the same order the pre-THE-465 monolith ran them, and
 * (additively) reporting a StageMetric per stage via opts.onStageMetric.
 */
export async function graphSearch(
  db: Database,
  opts: GraphSearchOptions,
): Promise<GraphSearchResult[]> {
  const core = await graphSearchCore(db, opts);
  return runStage(
    "projection",
    core.length,
    () => colbertRerankResults(db, core, opts),
    (r) => r.length,
    opts.onStageMetric,
  );
}

async function graphSearchCore(
  db: Database,
  opts: GraphSearchOptions,
): Promise<GraphSearchResult[]> {
  const seedCount = opts.seedCount ?? 30;
  const finalTopK = opts.finalTopK ?? 30;
  const maxExpansionChunks = opts.maxExpansionChunks ?? 50;
  const hopLimit = opts.hopLimit ?? 2;
  const similarityThreshold = opts.similarityThreshold ?? 0.2;
  const fusionMode = opts.fusionMode ?? "graph_rrf";
  // THE-397: k=10, not the folklore k=60. With ~30-item pools, k=60 lets a document at rank M
  // in TWO streams outrank a rank-1 single-stream hit whenever k > M-2 (2/(k+M) > 1/(k+1)) —
  // overlapping noise buries confident dense hits. Measured at n=32: k=10 Pareto-dominates k=60
  // (nDCG .444 vs .426, recall .586 vs .569, MRR +.024, bridge equal; replicated on a second
  // index), while k=20 ≈ k=60 — the effect appears only below the pool-size crossover.
  const rrfK = opts.rrfK ?? 10;
  const rerankPool = opts.rerankPool ?? 40;
  const routerEnabled = opts.router?.enabled ?? true;
  const routerSim = opts.router?.simThreshold ?? 0.62;
  const routerMargin = opts.router?.margin ?? 0.08;
  const decayEnabled = opts.decay?.enabled ?? false;
  const decayLambda = opts.decay?.lambda ?? DEFAULT_DECAY_LAMBDA;
  const decayNowMs = opts.decay?.nowMs ?? Date.now();
  const onStageMetric = opts.onStageMetric;

  // Stage: seedGeneration (vector + lexical + sparse seeds).
  const { seeds, lexHits, sparseHits } = await runStage(
    "seedGeneration",
    0,
    () => generateSeeds({ db, opts, seedCount }),
    (r) => r.seeds.length + r.lexHits.length + r.sparseHits.length,
    onStageMetric,
  );
  if (seeds.length === 0 && lexHits.length === 0 && sparseHits.length === 0) return [];

  // Stage: classify (seed-strength router).
  const { zMargin, routedToSeedsOnly } = await runStage(
    "classify",
    seeds.length,
    () =>
      classify({
        seeds,
        routerEnabled,
        routerSim,
        routerMargin,
        zThreshold: opts.router?.zThreshold,
      }),
    () => seeds.length,
    onStageMetric,
  );

  const seedChunkIds = new Set(seeds.map((s) => s.chunk_id));
  const seedPaths = [...new Set(seeds.map((s) => s.path))];

  // Stage: graphExpansion (skipped entirely — no DB call — when the router routes to
  // seeds-only, exactly as before THE-465; still reports a zero-work StageMetric).
  let expansionChunks: Candidate[] = [];
  let expSimById = new Map<string, number>();
  if (!routedToSeedsOnly) {
    const r = await runStage(
      "graphExpansion",
      seedPaths.length,
      () =>
        expandGraph({
          db,
          opts,
          seedPaths,
          seedChunkIds,
          hopLimit,
          similarityThreshold,
          maxExpansionChunks,
          decayEnabled,
          decayLambda,
          decayNowMs,
        }),
      (res) => res.expansionChunks.length,
      onStageMetric,
    );
    expansionChunks = r.expansionChunks;
    expSimById = r.expSimById;
  } else if (onStageMetric) {
    onStageMetric({
      stage: "graphExpansion",
      candidatesIn: seedPaths.length,
      candidatesOut: 0,
      durationMs: 0,
    });
  }

  // Stage: candidateAssembly (merge seed/expansion/lexical/sparse/temporal streams).
  const {
    candidates,
    lexRankById,
    lexScoreById,
    sparseRankById,
    sparseScoreById,
    temporalRankById,
  } = await runStage(
    "candidateAssembly",
    seeds.length + expansionChunks.length + lexHits.length + sparseHits.length,
    () =>
      assembleCandidates({
        db,
        opts,
        seedCount,
        seeds,
        expansionChunks,
        lexHits,
        sparseHits,
        onStage: opts.onStage,
      }),
    (r) => r.candidates.length,
    onStageMetric,
  );
  if (candidates.length === 0) return [];

  // Fusion mode "score_merge" bypasses the RRF/convex fusion pipeline (scoreFusion/diversity/
  // gatedRerank stages) entirely — same early return as before THE-465.
  if (fusionMode === "score_merge") {
    const ranked = await rerankWithScores(
      opts.query,
      candidates,
      Math.min(finalTopK, candidates.length),
      opts.reranker,
    );
    return finalize(ranked, opts);
  }

  // Stage: scoreFusion (adaptive RRF tilt / RRF / convex, metadata prior, final sort).
  opts.onStage?.("fused", candidates.length);
  const { fused, scoreOfWithPrior, isConvex } = await runStage(
    "scoreFusion",
    candidates.length,
    () =>
      fuseScores({
        db,
        opts,
        candidates,
        seeds,
        expSimById,
        lexRankById,
        lexScoreById,
        sparseRankById,
        sparseScoreById,
        temporalRankById,
        rrfK,
        fusionMode,
      }),
    (r) => r.fused.length,
    onStageMetric,
  );

  if (fusionMode === "graph_rrf" || isConvex) {
    // Stage: diversity (note-collapse, cluster cap, MMR).
    const capped = await runStage(
      "diversity",
      fused.length,
      () => applyDiversity({ db, opts, fused, finalTopK, scoreOfWithPrior }),
      (r) => r.length,
      onStageMetric,
    );
    // Stage: gatedRerank (THE-394 hard-query gate; falls through to plain projection).
    return runStage(
      "gatedRerank",
      capped.length,
      () => applyGatedRerank({ opts, capped, seeds, zMargin, routedToSeedsOnly, scoreOfWithPrior }),
      (r) => r.length,
      onStageMetric,
    );
  }

  // rrf_rerank: rerank the top-RRF pool for the final order.
  const pool = fused.slice(0, Math.min(rerankPool, fused.length));
  const ranked = await rerankWithScores(
    opts.query,
    pool,
    Math.min(finalTopK, pool.length),
    opts.reranker,
  );
  return finalize(ranked, opts);
}
