import { tableExists } from "../db/introspect";
import type { Database } from "../db/types";
import { confidenceFor, type RetrievalConfidence } from "../experiential/calibration";
import {
  type ClusterSummaryHit,
  hasClusterSummaries,
  searchClusterSummaries,
} from "./cluster-summaries";
import { mtimesByPath, noteFreshness, STALE_THRESHOLD_DAYS } from "./freshness";
import { assembleCandidates } from "./graph_search_stages/candidate_assembly";
import { classify, seedZMargin } from "./graph_search_stages/classify";
import { applyDiversity } from "./graph_search_stages/diversity";
import { clampMetadataBoost, fuseScores } from "./graph_search_stages/fusion";
import { expandGraph } from "./graph_search_stages/graph_expansion";
import { runStage, type StageName } from "./graph_search_stages/instrumentation";
import { colbertRerankResults, finalize } from "./graph_search_stages/projection";
import { applyGatedRerank } from "./graph_search_stages/rerank_stage";
import { generateSeeds } from "./graph_search_stages/seed_generation";
import {
  type Candidate,
  type CoverageEstimate,
  DEFAULT_DECAY_LAMBDA,
  type FusionMode,
  type GraphSearchOptions,
  type GraphSearchResult,
} from "./graph_search_stages/types";
import { hasNoteSummaries, type SummaryHit, searchNoteSummaries } from "./note-summaries";
import { rerankWithScores } from "./rerank";

// Public API is unchanged by THE-465: same graphSearch(db, opts) signature, same
// GraphSearchResult shape, same GraphSearchOptions surface (every opts.* default preserved) —
// re-exported here from graph_search_stages/types so every existing import path
// (`from "./graph_search"` / `from "../../search/graph_search"`) keeps working untouched.
export type { CoverageEstimate, FusionMode, GraphSearchOptions, GraphSearchResult };
export { clampMetadataBoost, seedZMargin };

// THE-631: the full GraphSearchResult.source taxonomy — the denominator for
// CoverageEstimate.armsPossible. Deliberately excludes "summary"/"cluster_summary" (THE-628):
// adding either would move armsPossible from 5 to 6 for every search, including the flag-off
// default where those streams never run. Extend only once a summary stream is on by default.
// See docs/design/retrieval-graph-search-pipeline.md.
const ALL_SOURCES = ["seed", "expansion", "lexical", "sparse", "temporal"] as const;

/**
 * THE-631: an honest, additive coverage estimate for one completed graphSearch call. Grounded in
 * what the pipeline actually did — never a fabricated 0-1 confidence number:
 *   - arms/armsContributed: which of the five possible streams contributed a surviving hit to
 *     THIS result set, observed from the results themselves (not from which streams were merely
 *     enabled in opts — a stream can be on and still contribute zero hits, e.g. no lexical term
 *     match).
 *   - expansionSkipped vs expansionTruncated: two different reasons expansion contributes little
 *     or nothing. Skipped means the seed-strength router (classify.ts) judged the seeds strong
 *     enough and never ran expansion at all — a deliberate decision, not a gap. Truncated means
 *     expansion ran and found MORE qualifying candidates than maxExpansionChunks/a per-seed cap
 *     kept — a genuine coverage gap.
 *   - requested/returned/underfilled: the plainest signal. `underfilled` is true when the
 *     pipeline returned fewer chunks than the caller asked for (finalTopK) — the corpus/graph did
 *     not have enough qualifying candidates to fill the page. Not a ranking judgment.
 *
 * Exported and pure (no DB access) so it is unit-testable against a known GraphSearchResult[]
 * fixture without a live search. Reported ONLY via opts.onCoverage — this value is never read
 * back into scoring, fusion, or ordering anywhere in this pipeline.
 */
export function estimateCoverage(
  results: GraphSearchResult[],
  requested: number,
  pipeline: { routedToSeedsOnly: boolean; expansionTruncated: boolean },
  /** THE-733: the placed confidence, computed by the caller from the vault's persisted calibration.
   *  Passed in rather than looked up so this function stays PURE — the same contract the staleness
   *  half holds (`countStaleNotes` does the DB work, this does none). Defaults to the honest
   *  not-calibrated answer, so a caller that forgets to wire it degrades to "no claim" rather than
   *  to a fabricated number. */
  confidence: RetrievalConfidence = { available: false, reason: "not_calibrated" },
  staleness: { staleReturned: number; staleUnknown: number; thresholdDays: number } = {
    staleReturned: 0,
    staleUnknown: 0,
    thresholdDays: STALE_THRESHOLD_DAYS,
  },
): CoverageEstimate {
  const arms = ALL_SOURCES.filter((s) => results.some((r) => r.source === s));
  return {
    confidence,
    arms: [...arms],
    armsContributed: arms.length,
    armsPossible: ALL_SOURCES.length,
    expansionSkipped: pipeline.routedToSeedsOnly,
    expansionTruncated: pipeline.expansionTruncated,
    requested,
    returned: results.length,
    underfilled: results.length < requested,
    staleReturned: staleness.staleReturned,
    staleUnknown: staleness.staleUnknown,
    staleThresholdDays: staleness.thresholdDays,
  };
}

/**
 * THE-631 item 2: the DB half of the staleness signal, kept out of `estimateCoverage` so that
 * function stays pure and fixture-testable (see its doc comment).
 *
 * Counts DISTINCT notes, not chunks: a query returning six chunks of one stale note reports one
 * stale note, because otherwise the number measures chunking granularity rather than the vault.
 * A path with no `notes` row counts as UNKNOWN rather than fresh — a pruned or never-indexed note
 * is not evidence of recency, and collapsing the two would fabricate freshness.
 *
 * Reuses THE-450's `mtimesByPath` + `noteFreshness` rather than issuing its own mtime query, so
 * this aggregate and the per-hit `age_days`/`stale` stamps on the m2 search tools can never drift
 * to different answers about the same note.
 */
export function countStaleNotes(
  db: Database,
  vaultId: string,
  results: GraphSearchResult[],
  nowMs: number,
  thresholdDays: number,
): { staleReturned: number; staleUnknown: number; thresholdDays: number } {
  const paths = [...new Set(results.map((r) => r.path))];
  if (paths.length === 0) return { staleReturned: 0, staleUnknown: 0, thresholdDays };
  // GUARDED on existence, same reasoning as db/maintenance.ts's job_schedule prune: `notes` arrives
  // in 20260702_001, so a cache.db provisioned before it — or any fixture running a shorter
  // migration chain — does not have the table. An unguarded SELECT throws "no such table: notes"
  // from inside a SEARCH REQUEST, turning an additive observability field into a query outage.
  // Every path is then UNKNOWN rather than fresh, which is the honest reading: the ages were not
  // consulted, so nothing is known about them.
  if (!tableExists(db, "notes")) {
    return { staleReturned: 0, staleUnknown: paths.length, thresholdDays };
  }
  const mtimes = mtimesByPath(db, vaultId, paths);
  let staleReturned = 0;
  let staleUnknown = 0;
  for (const p of paths) {
    const mtime = mtimes.get(p);
    if (mtime === undefined) staleUnknown += 1;
    else if (noteFreshness(mtime, nowMs, thresholdDays).stale) staleReturned += 1;
  }
  return { staleReturned, staleUnknown, thresholdDays };
}

// THE-585 (#12): content bytes hydrated at the two boundaries that matter — how much duplicate
// hydration candidateAssembly's dedup absorbs, and how much of what got hydrated the diversity/
// gatedRerank top-K cut then discards. Byte length (Buffer.byteLength), not character count, so
// this tracks actual wire/memory cost rather than a locale-dependent character count. Structural
// over the element type so it works across Candidate[]/GraphSearchResult[] and the raw
// pre-merge hit arrays (SemanticHit/LexicalHit/SparseHit) without a shared base type.
function contentBytes(items: ReadonlyArray<{ content?: string | null }>): number {
  let total = 0;
  for (const item of items) {
    if (item.content) total += Buffer.byteLength(item.content, "utf8");
  }
  return total;
}

/**
 * GraphRAG search — THE-233 port of knowledge-mcp-server vault_graph_search.
 * Vector seeds (semanticSearch — obsidian-tc has no chunk-level hybrid) -> seed-strength
 * router -> literal links_to expansion -> RRF fusion. Default fusionMode graph_rrf makes RRF
 * over the seed + expansion streams the final ranking (no reranker call, so a rank-1 seed
 * cannot be displaced by an inflated expansion score); rrf_rerank / score_merge route through
 * the injected reranker (D1 gateway passthrough at integration; no-op fallback otherwise).
 *
 * A thin orchestrator (THE-465) over the staged pipeline in `./graph_search_stages/`: each
 * stage is separately-typed and separately-testable, and this function's only job is threading
 * their typed inputs/outputs together and (additively) reporting a StageMetric per stage via
 * opts.onStageMetric. Stage order and the classify/seedGeneration ordering constraint are
 * documented in docs/design/retrieval-graph-search-pipeline.md.
 */
export async function graphSearch(
  db: Database,
  opts: GraphSearchOptions,
): Promise<GraphSearchResult[]> {
  const core = await graphSearchCore(db, opts);
  const results = await runStage(
    "projection",
    core.results.length,
    () => colbertRerankResults(db, core.results, opts),
    (r) => r.length,
    opts.onStageMetric,
  );
  // The LAST word (THE-632) — what the caller actually receives. A note present here was
  // returned; absent here after being present at gatedRerank means projection (ColBERT rerank)
  // dropped it.
  traceStage(opts, "projection", core.results.length, results, candidateId);
  // Fired AFTER projection (THE-631) so the estimate describes exactly what the caller receives;
  // never fed back into the pipeline above — see estimateCoverage()'s doc comment.
  if (opts.onCoverage) {
    // The mtime lookup runs ONLY when a caller asked for coverage, so ordinary search pays
    // nothing for it. One batched query over the distinct returned paths, after projection, so it
    // describes exactly what the caller receives.
    opts.onCoverage(
      estimateCoverage(
        results,
        core.finalTopK,
        {
          routedToSeedsOnly: core.routedToSeedsOnly,
          expansionTruncated: core.expansionTruncated,
        },
        // THE-733: placed against the vault's own distribution. `confidenceFor` returns the
        // not-calibrated branch when opts carries no calibration, so an unconfigured deployment
        // reports no claim rather than a number derived from a global constant. `rerank_score` is
        // the field gap-sweep.ts's calibration was built from (`score: r.rerank_score`) — placing
        // any other score against this distribution would be miscalibrated.
        confidenceFor(
          results[0]?.rerank_score,
          opts.scoreCalibration ?? null,
          opts.engineVersion ?? "",
        ),
        countStaleNotes(
          db,
          opts.vaultId,
          results,
          Date.now(),
          opts.staleThresholdDays ?? STALE_THRESHOLD_DAYS,
        ),
      ),
    );
  }
  return results;
}

/**
 * Emit one trace record (THE-632) for the followed path at a stage boundary.
 *
 * Lives here rather than inside the stage modules because this function already holds every
 * intermediate array between stages, so tracing costs no change to any stage's own logic and a
 * stage cannot drift from what the trace claims about it.
 *
 * Pure side-channel, on the same contract as onCoverage: reads the arrays and reports, never
 * filters/reorders/feeds anything back, so results are byte-identical with tracing on or off.
 * Returns immediately, before touching anything, when `traceNotePath` is unset.
 */
function traceStage<T>(
  opts: GraphSearchOptions,
  stage: StageName,
  candidatesIn: number,
  out: readonly T[],
  idOf: (item: T) => { path: string; id: string },
  // Takes the ITEM, not an id: the pipeline's own scorers (scoreOfWithPrior) are item-shaped, and
  // reshaping them here would mean re-deriving a lookup the stage already has.
  scoreOf?: (item: T) => number | undefined,
  note?: string,
): void {
  const target = opts.traceNotePath;
  const emit = opts.onRetrievalTrace;
  if (target === undefined || emit === undefined) return;
  let chunksPresent = 0;
  let rank: number | undefined;
  let score: number | undefined;
  for (let i = 0; i < out.length; i++) {
    const item = out[i];
    if (item === undefined) continue;
    const { path } = idOf(item);
    if (path !== target) continue;
    chunksPresent++;
    // First occurrence is the best one: every array reaching here is already in the stage's own
    // order, so index 0 of the matches IS the note's rank.
    if (rank === undefined) {
      rank = i;
      score = scoreOf?.(item);
    }
  }
  // Exception-isolated (THE-632) — a throwing trace sink must never break the search it
  // observes. See docs/design/retrieval-graph-search-pipeline.md.
  try {
    emit({
      stage,
      present: chunksPresent > 0,
      chunksPresent,
      candidatesIn,
      candidatesOut: out.length,
      // Omitted, never defaulted to 0 — an invented zero reads as "scored terribly" rather than
      // "this stage does not score".
      ...(score !== undefined ? { score } : {}),
      ...(rank !== undefined ? { rank } : {}),
      ...(note !== undefined ? { note } : {}),
    });
  } catch {
    /* a trace sink must never break the search it is observing */
  }
}

const candidateId = (c: { chunk_id: string; path: string }): { path: string; id: string } => ({
  path: c.path,
  id: c.chunk_id,
});

interface GraphSearchCoreResult {
  results: GraphSearchResult[];
  finalTopK: number;
  routedToSeedsOnly: boolean;
  expansionTruncated: boolean;
}

async function graphSearchCore(
  db: Database,
  opts: GraphSearchOptions,
): Promise<GraphSearchCoreResult> {
  const seedCount = opts.seedCount ?? 30;
  const finalTopK = opts.finalTopK ?? 30;
  const maxExpansionChunks = opts.maxExpansionChunks ?? 50;
  const hopLimit = opts.hopLimit ?? 2;
  const similarityThreshold = opts.similarityThreshold ?? 0.2;
  const fusionMode = opts.fusionMode ?? "graph_rrf";
  // THE-397: k=10, not the folklore k=60 — with ~30-item pools, k=60 lets a document at rank M
  // in TWO streams outrank a rank-1 single-stream hit whenever k > M-2 (2/(k+M) > 1/(k+1)),
  // burying confident dense hits under overlapping noise. Measured better-or-equal on all gate
  // metrics at this pool size; see CHANGELOG.md [1.5.0] THE-397 for the numbers.
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
  // THE-628: note-summary stream, dark behind opts.summaries?.enabled — undefined/false means
  // note_summaries is never queried (a true no-op, not just an empty result). Not wrapped in its
  // own runStage: one query alongside seedGeneration's three, not a separate pipeline phase; see
  // this file's ALL_SOURCES comment for the matching coverage-taxonomy decision.
  const summaryHits: SummaryHit[] =
    (opts.summaries?.enabled ?? false) && hasNoteSummaries(db)
      ? searchNoteSummaries(db, opts.vaultId, opts.queryVec, {
          k: seedCount,
          ...(opts.isReadable ? { isReadable: opts.isReadable } : {}),
        })
      : [];
  // THE-628: cluster-summary stream, dark behind opts.summaries?.clusters?.enabled — a separate
  // flag from the note-level one above (see GraphSearchOptions.summaries's comment for why).
  // Same true-no-op contract as summaryHits. searchClusterSummaries applies its own (stricter,
  // multi-note) isReadable filter internally — see that function's doc comment.
  const clusterSummaryHits: ClusterSummaryHit[] =
    (opts.summaries?.clusters?.enabled ?? false) && hasClusterSummaries(db)
      ? searchClusterSummaries(db, opts.vaultId, opts.queryVec, {
          k: seedCount,
          ...(opts.isReadable ? { isReadable: opts.isReadable } : {}),
          // THE-934 fix round 3 (D): a cluster summary's own `.path` is the cluster_key, not a
          // real vault path, so a downstream isExcludedPath(excludeFilter, hit.path) check
          // (rerank.ts, reflect.ts) can never see an excluded member -- this is the one place
          // with the real member-path list. Reuses `rerankExcludeFilter` (same config value,
          // already threaded here for the reranker's own backstop) rather than adding a second
          // field for what is the same filter.
          ...(opts.rerankExcludeFilter ? { excludeFilter: opts.rerankExcludeFilter } : {}),
        })
      : [];
  // Traced BEFORE the early return below (THE-632) so the no-seed case produces a real record
  // instead of an empty one — see docs/design/retrieval-graph-search-pipeline.md. All three arms
  // are ACL-filtered at query time (seed_generation), so this count never includes a chunk the
  // caller cannot read.
  traceStage(
    opts,
    "seedGeneration",
    0,
    [...seeds, ...lexHits, ...sparseHits],
    candidateId,
    undefined,
    "the retrieval arms: dense seeds, lexical (BM25) and sparse. Absent here means no arm matched the note directly — graph expansion may still reach it.",
  );
  // THE-628: summaryHits/clusterSummaryHits join the early-return guard so a query that matches
  // only a note or cluster summary (the "global/thematic" case a chunk-only pipeline can't
  // answer) isn't zeroed out here. Both are always 0-length when their flag is off, so this
  // condition is unchanged on the default config.
  if (
    seeds.length === 0 &&
    lexHits.length === 0 &&
    sparseHits.length === 0 &&
    summaryHits.length === 0 &&
    clusterSummaryHits.length === 0
  )
    return { results: [], finalTopK, routedToSeedsOnly: false, expansionTruncated: false };

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
  let expansionTruncated = false;
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
    expansionTruncated = r.truncated;
    // THE-632: without this, absence at candidateAssembly could not distinguish "the graph walk
    // never reached this note" from "it reached it and dropped it on the similarity threshold, the
    // hub-degree cap, a per-seed cap, or the global expansion cap". The summary previously claimed
    // "not retrieved by any arm", which is stronger than the evidence supported.
    traceStage(
      opts,
      "graphExpansion",
      seedPaths.length,
      expansionChunks,
      candidateId,
      undefined,
      expansionTruncated
        ? "expansion found MORE qualifying candidates than the caps kept — absence here may be truncation rather than distance"
        : "the links_to walk from the seed notes; absence here means the walk did not reach the note, or it was cut by the similarity threshold or a hub/per-seed cap",
    );
  } else {
    // Router skipped expansion entirely (seeds judged strong enough). A trace that omitted this
    // would leave the reader inferring a drop where no stage ever ran.
    traceStage(
      opts,
      "graphExpansion",
      seedPaths.length,
      [],
      candidateId,
      undefined,
      "SKIPPED — the seed-strength router judged the seeds strong enough and never ran expansion. Absence here is a deliberate decision, not a coverage gap.",
    );
  }
  if (routedToSeedsOnly && onStageMetric) {
    onStageMetric({
      stage: "graphExpansion",
      candidatesIn: seedPaths.length,
      candidatesOut: 0,
      durationMs: 0,
    });
  }

  // Stage: candidateAssembly (merge seed/expansion/lexical/sparse/temporal streams).
  // THE-585 (#12): bytesIn is the pre-merge, pre-dedup total across the four streams that
  // already carry content — a chunk hit by more than one stream is counted once per stream
  // here, then once (deduped) in bytesOut. The gap between them is hydration wasted on the
  // SAME chunk fetched via more than one path, before dedup ever runs.
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
        summaryHits,
        clusterSummaryHits,
        onStage: opts.onStage,
      }),
    (r) => r.candidates.length,
    onStageMetric,
    {
      in:
        contentBytes(seeds) +
        contentBytes(expansionChunks) +
        contentBytes(lexHits) +
        contentBytes(sparseHits),
      out: (r) => contentBytes(r.candidates),
    },
  );
  traceStage(
    opts,
    "candidateAssembly",
    seeds.length + expansionChunks.length + lexHits.length + sparseHits.length,
    candidates,
    candidateId,
    undefined,
    // The single most valuable answer, and the one a score-oriented design cannot give: a note that
    // never became a candidate has no score at any later stage to explain its absence.
    "absent here means the note never entered the candidate pool — no later stage can score it",
  );
  if (candidates.length === 0)
    return { results: [], finalTopK, routedToSeedsOnly, expansionTruncated };

  // Fusion mode "score_merge" bypasses the RRF/convex fusion pipeline (scoreFusion/diversity/
  // gatedRerank stages) entirely — same early return as before THE-465.
  if (fusionMode === "score_merge") {
    const ranked = await rerankWithScores(
      opts.query,
      candidates,
      Math.min(finalTopK, candidates.length),
      opts.reranker,
      opts.onRerankOutcome,
      undefined,
      opts.rerankExcludeFilter,
    );
    return { results: finalize(ranked, opts), finalTopK, routedToSeedsOnly, expansionTruncated };
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

  traceStage(opts, "scoreFusion", candidates.length, fused, candidateId, scoreOfWithPrior);

  if (fusionMode === "graph_rrf" || isConvex) {
    // Stage: diversity (note-collapse, cluster cap, MMR). THE-585 (#12): this is the top-K cut
    // the ticket names — `fused` carries every hydrated candidate; `capped` is what survives.
    // bytesIn - bytesOut here is content that was fetched and then thrown away unread.
    const capped = await runStage(
      "diversity",
      fused.length,
      () => applyDiversity({ db, opts, fused, finalTopK, scoreOfWithPrior }),
      (r) => r.length,
      onStageMetric,
      { in: contentBytes(fused), out: (r) => contentBytes(r) },
    );
    // Stage: gatedRerank (THE-394 hard-query gate; falls through to plain projection).
    const gated = await runStage(
      "gatedRerank",
      capped.length,
      () => applyGatedRerank({ opts, capped, seeds, zMargin, routedToSeedsOnly, scoreOfWithPrior }),
      (r) => r.length,
      onStageMetric,
      { in: contentBytes(capped), out: (r) => contentBytes(r) },
    );
    traceStage(
      opts,
      "diversity",
      fused.length,
      capped,
      candidateId,
      scoreOfWithPrior,
      "the top-K cut: note-collapse (diversify.maxPerNote), cluster cap, then MMR",
    );
    traceStage(opts, "gatedRerank", capped.length, gated, candidateId, undefined);
    return { results: gated, finalTopK, routedToSeedsOnly, expansionTruncated };
  }

  // rrf_rerank: rerank the top-RRF pool for the final order.
  const pool = fused.slice(0, Math.min(rerankPool, fused.length));
  const ranked = await rerankWithScores(
    opts.query,
    pool,
    Math.min(finalTopK, pool.length),
    opts.reranker,
    opts.onRerankOutcome,
    undefined,
    opts.rerankExcludeFilter,
  );
  return { results: finalize(ranked, opts), finalTopK, routedToSeedsOnly, expansionTruncated };
}
