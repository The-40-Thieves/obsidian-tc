// Ported from knowledge-mcp-server eval/failure_analysis.ts (retired). Classifies each golden
// query into a single failure class and maps it to the ONE v1.1 remediation lever that would move
// it, then aggregates a "what to build next" recommendation.
//
// The classification is a pure decision tree over plain data: the query, its baseline/treatment
// per-query metrics, the raw ranked results of both arms (so it can see which expected paths were
// retrieved and whether graph expansion fired), and a reachability set from the pure wikilink
// probe (reachability.ts) — NOT the DB — so the whole module is unit-testable in memory.
//
// obsidian-tc port: types are adapted to this repo's GoldenQuery / QueryMetrics / RankedChunk
// (eval/metrics.ts); the reachability set comes from reachability.ts's undirected `vault_edges`
// walk. The six failure classes and their exact lever mapping are preserved unchanged from the
// original — that mapping IS the deliverable.
import type { GoldenQuery, QueryMetrics, RankedChunk } from "./metrics";

export type FailureClass =
  | "success" // both per-query thresholds met — not a failure
  | "no_seeds" // no expected path in the baseline at all (data absent from the index / sync gap)
  | "ranking_miss" // target/bridge indexed but the golden seed_paths never rank in — bad query
  | "no_expansion" // graph expansion returned zero chunks: the seed is a wikilink leaf
  | "unreachable_in_graph" // expansion ran, but no target within maxHops wikilink hops of the seeds
  | "intra_domain_expansion" // target reachable in the graph but expansion noise buried it
  | "expansion_low_quality"; // expansion reached the target, rerank didn't promote it into top-10

export type V11Lever =
  | "none" // success — no work indicated
  | "llm_enrichment" // missing inferred edges (seeds are leaves / no cross-domain path)
  | "hub_noise_filter" // high-degree hub traversal polluting the candidate set
  | "reranker_tuning" // out of graph scope; investigate the rerank merge ordering
  | "sync_fix" // upstream data ingestion gap
  | "golden_set_fix"; // the query's seed_paths don't match what search retrieves — fix the query

export interface QueryFailureAnalysis {
  query_id: string;
  failure_class: FailureClass;
  recommended_v1_1_lever: V11Lever;
  baseline_recall_at_10: number;
  treatment_recall_at_10: number;
  recall_delta_pp: number;
  bridge_recall_baseline: 0 | 1;
  bridge_recall_treatment: 0 | 1;
  expansion_chunks_returned: number;
  expansion_reached_target: boolean;
  target_reachable_in_graph: boolean;
  baseline_found_any_seed_path: boolean;
  baseline_found_any_expected_path: boolean; // seeds OR targets OR bridges
  notes: string;
}

// Per-query threshold. A query is 'success' when BOTH hold (recall@10 >= this AND bridge_recall=1).
const PER_QUERY_RECALL_THRESHOLD = 0.5;

/**
 * Classify one golden query. Pure over plain data — `reachablePaths` is the set of paths reachable
 * within the probe's hop bound from the query's seeds (build it with reachability.ts's
 * `reachableTargetSet`), which is what separates "graph has no path to the target"
 * (unreachable_in_graph -> llm_enrichment) from "graph has a path but expansion noise buried it"
 * (intra_domain_expansion -> hub_noise_filter).
 */
export function analyzeQuery(
  query: GoldenQuery,
  baselineMetrics: QueryMetrics,
  treatmentMetrics: QueryMetrics,
  baselineRaw: RankedChunk[],
  treatmentRaw: RankedChunk[],
  reachablePaths: Set<string>,
): QueryFailureAnalysis {
  const expansion = treatmentRaw.filter((r) => r.source === "expansion");
  const expansionPaths = new Set(expansion.map((r) => r.path));
  const expansionReachedTarget = query.target_paths.some((p) => expansionPaths.has(p));

  // Pure-graph reachability, supplied by the runner's reachability probe. graph_search's own
  // expansion output cannot answer "is the target reachable at all" because of its similarity
  // filter and per-walk cap; this is what separates "graph has no path" (llm_enrichment) from
  // "graph has a path but expansion noise buried it" (hub_noise_filter).
  const targetReachableInGraph = query.target_paths.some((p) => reachablePaths.has(p));

  const baselinePathSet = new Set(baselineRaw.map((r) => r.path));
  const baselineFoundAnySeed = query.seed_paths.some((p) => baselinePathSet.has(p));

  // Tighter sync-gap check: distinguish "data absent" from "seed_paths specifically missed". If
  // baseline found ANY expected path (seed, target, or bridge), the data is indexed — the failure
  // is a ranking issue, not a sync gap.
  const allExpectedPaths = [...query.seed_paths, ...query.target_paths, ...query.bridge_paths];
  const baselineFoundAnyExpected = allExpectedPaths.some((p) => baselinePathSet.has(p));

  const recallDeltaPp = (treatmentMetrics.recall_at_10 - baselineMetrics.recall_at_10) * 100;

  const querySuccessful =
    treatmentMetrics.recall_at_10 >= PER_QUERY_RECALL_THRESHOLD &&
    treatmentMetrics.bridge_recall === 1;

  let failure_class: FailureClass;
  let lever: V11Lever;
  let notes: string;

  if (querySuccessful) {
    failure_class = "success";
    lever = "none";
    notes = `recall@10=${(treatmentMetrics.recall_at_10 * 100).toFixed(0)}%, bridge_recall=1`;
  } else if (!baselineFoundAnyExpected) {
    // Neither seed_paths, target_paths, nor bridge_paths appeared in baseline results. True sync
    // gap: the data is not in the index.
    failure_class = "no_seeds";
    lever = "sync_fix";
    notes =
      "Baseline semantic search returned zero results from the expected path set (seed, target, " +
      "and bridge paths all absent). Data likely not indexed. Verify the source folder is in the " +
      "embedder include list and the vault has been reconciled.";
  } else if (!baselineFoundAnySeed) {
    // Target or bridge paths appeared in baseline, but not seed_paths specifically. Data is
    // indexed — the golden seed_paths just don't match what search retrieves for this query text.
    failure_class = "ranking_miss";
    lever = "golden_set_fix";
    notes =
      "Baseline found target/bridge paths but not seed_paths. Data is indexed. The seed_paths in " +
      "the golden query do not match what search actually retrieves for this query text. Fix the " +
      "query: pick seed_paths that appear in the top results, or adjust query_text.";
  } else if (expansion.length === 0) {
    failure_class = "no_expansion";
    lever = "llm_enrichment";
    notes =
      "Seeds had no outgoing links_to edges (leaves in the wikilink graph). LLM-extracted " +
      "inferred edges from the seed chunks would create paths into the target domain.";
  } else if (!expansionReachedTarget && !targetReachableInGraph) {
    // Expansion ran, but no target_path is within the probe's hop bound of the seeds. No expansion
    // tuning can surface a node the graph cannot reach — the fix is new edges, not hub filtering.
    failure_class = "unreachable_in_graph";
    lever = "llm_enrichment";
    notes =
      `Expansion returned ${expansion.length} chunks but NO target_path is reachable within the ` +
      "wikilink hop bound of the seeds. The graph has no path to the target domain, so hub " +
      "filtering cannot help. Lever is llm_enrichment: extract inferred cross-domain edges.";
  } else if (!expansionReachedTarget) {
    // Target IS reachable in the graph but did not survive into the result set. Candidate-set
    // pollution: hub fan-out or the expansion cap/similarity filter crowded it out.
    failure_class = "intra_domain_expansion";
    lever = "hub_noise_filter";
    notes =
      `Expansion returned ${expansion.length} chunks. A target_path IS reachable within the hop ` +
      "bound but did not survive expansion. High-degree hub fan-out, the per-walk cap, or the " +
      "similarity threshold buried it. Hub-aware expansion or a per-root-seed quota should recover it.";
  } else {
    failure_class = "expansion_low_quality";
    lever = "reranker_tuning";
    notes =
      "Expansion reached target_paths but rerank did not promote target chunks into top-10. Out " +
      "of graph scope. Investigate the reranker prompt or merge ordering.";
  }

  return {
    query_id: query.id,
    failure_class,
    recommended_v1_1_lever: lever,
    baseline_recall_at_10: baselineMetrics.recall_at_10,
    treatment_recall_at_10: treatmentMetrics.recall_at_10,
    recall_delta_pp: recallDeltaPp,
    bridge_recall_baseline: baselineMetrics.bridge_recall,
    bridge_recall_treatment: treatmentMetrics.bridge_recall,
    expansion_chunks_returned: expansion.length,
    expansion_reached_target: expansionReachedTarget,
    target_reachable_in_graph: targetReachableInGraph,
    baseline_found_any_seed_path: baselineFoundAnySeed,
    baseline_found_any_expected_path: baselineFoundAnyExpected,
    notes,
  };
}

export interface V11Recommendation {
  primary_lever: V11Lever;
  secondary_lever: V11Lever | null;
  reasoning: string;
  failures_by_class: Record<FailureClass, number>;
  failures_by_lever: Record<V11Lever, number>;
}

/**
 * Aggregate per-query analyses into a single "what to build next" recommendation: counts per class
 * and per lever, and the dominant (and runner-up) lever by failing-query count.
 */
export function recommendV11(perQuery: QueryFailureAnalysis[]): V11Recommendation {
  const byClass: Record<FailureClass, number> = {
    success: 0,
    no_seeds: 0,
    ranking_miss: 0,
    no_expansion: 0,
    unreachable_in_graph: 0,
    intra_domain_expansion: 0,
    expansion_low_quality: 0,
  };
  const byLever: Record<V11Lever, number> = {
    none: 0,
    llm_enrichment: 0,
    hub_noise_filter: 0,
    reranker_tuning: 0,
    sync_fix: 0,
    golden_set_fix: 0,
  };
  for (const q of perQuery) {
    byClass[q.failure_class]++;
    byLever[q.recommended_v1_1_lever]++;
  }

  const ranked = (Object.keys(byLever) as V11Lever[])
    .filter((k) => k !== "none" && byLever[k] > 0)
    .map((k) => [k, byLever[k]] as const)
    .sort(([, a], [, b]) => b - a);

  const primary = ranked[0]?.[0] ?? "none";
  const secondary = ranked[1]?.[0] ?? null;

  const total = perQuery.length;
  const successCount = byClass.success;
  const failedCount = total - successCount;

  let reasoning: string;
  if (failedCount === 0) {
    reasoning = `All ${total} queries pass per-query thresholds (recall@10 >= 50% AND bridge_recall = 1). No v1.1 work indicated.`;
  } else {
    reasoning = `${failedCount}/${total} queries did not meet per-query thresholds.`;
    if (primary !== "none") {
      reasoning += ` Primary failure lever: ${primary} (${byLever[primary]} queries).`;
    }
    if (secondary) {
      reasoning += ` Secondary: ${secondary} (${byLever[secondary]} queries).`;
    }
  }

  return {
    primary_lever: primary,
    secondary_lever: secondary,
    reasoning,
    failures_by_class: byClass,
    failures_by_lever: byLever,
  };
}
