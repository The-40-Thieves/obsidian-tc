// THE-449 — category slices over the golden set.
//
// The aggregate metrics answer "did the arm move?". They cannot answer "on WHAT?" — a +0.004 mean
// nDCG could be a broad small gain or a large gain on temporal queries cancelling a large loss on
// lexical ones. Those call for opposite next actions, and the aggregate cannot tell them apart.
//
// Categories come from two places on purpose:
//
//   1. An explicit `categories` field on a golden query — author-controlled, arbitrary labels
//      (temporal, lexical, multi-hop, whatever the mining pass recorded).
//   2. A DERIVED domain category, so an existing golden set slices usefully with zero
//      re-annotation. The real set has 136 queries; requiring a manual pass over all of them
//      before a single slice worked is how this criterion stayed unbuilt while the rest of
//      THE-449 shipped.
import type { AggregateMetrics, GoldenQuery, QueryMetrics } from "./metrics";

/**
 * Every category a query belongs to — explicit labels plus the derived domain one. Sorted and
 * deduplicated so slice keys are stable across runs (the eval report is diffed between arms).
 */
export function categoriesOf(q: GoldenQuery): string[] {
  const explicit = Array.isArray((q as { categories?: unknown }).categories)
    ? ((q as { categories: unknown[] }).categories.filter((c) => typeof c === "string") as string[])
    : [];
  // seed_domain === target_domain means the answer lives where the question started: no domain hop
  // is required. That distinction is the single most useful free axis in the existing schema.
  const derived = q.seed_domain === q.target_domain ? "single-domain" : "cross-domain";
  return [...new Set([...explicit, derived])].sort();
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Aggregate per category. Each slice's denominator is its OWN query count — dividing by the full
 * set would deflate every slice and make a real per-category regression read as a small global one.
 *
 * A metric with no matching query is ignored rather than counted: the two inputs are produced by
 * different passes, and a stale id must not inflate a slice.
 */
export function sliceByCategory(
  queries: GoldenQuery[],
  metrics: QueryMetrics[],
): Record<string, AggregateMetrics> {
  const byId = new Map(queries.map((q) => [q.id, q]));
  const buckets = new Map<string, QueryMetrics[]>();

  for (const m of metrics) {
    const q = byId.get(m.query_id);
    if (!q) continue;
    for (const cat of categoriesOf(q)) {
      const list = buckets.get(cat) ?? [];
      list.push(m);
      buckets.set(cat, list);
    }
  }

  const out: Record<string, AggregateMetrics> = {};
  for (const [cat, ms] of [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const bridge = ms.filter((m) => (m as { declares_bridge?: boolean }).declares_bridge === true);
    out[cat] = {
      query_count: ms.length,
      mean_recall_at_10: mean(ms.map((m) => m.recall_at_10)),
      mean_mrr_at_10: mean(ms.map((m) => m.mrr_at_10)),
      mean_ndcg_at_10: mean(ms.map((m) => m.ndcg_at_10)),
      bridge_recall_rate: mean(ms.map((m) => (m as { bridge_recall?: number }).bridge_recall ?? 0)),
      // Same separate-denominator rule the top-level aggregate uses (THE-440): bridge nDCG is
      // meaned over the queries that DECLARE bridge paths, not over the whole slice.
      mean_bridge_ndcg_at_10: mean(
        bridge.map((m) => (m as { bridge_ndcg_at_10?: number }).bridge_ndcg_at_10 ?? 0),
      ),
      bridge_query_count: bridge.length,
    };
  }
  return out;
}
