// Retrieval-quality eval metrics — THE-233 W-RETRIEVAL, ported from
// knowledge-mcp-server eval/metrics.ts (multi-hop track). Pure functions over a golden
// query (seed/target/bridge paths) and a ranked result list. recall@10 / MRR@10 /
// bridge_recall are the gate metrics that decide whether graph + rerank regress retrieval.
//
// The live golden set (multi-hop-golden-set.yaml) + baseline.json + the paired-bootstrap
// CI gate run against an indexed corpus; that wiring is gated on a settled embedding
// provider / Slice-5 export (no model is pulled locally and the vault is 921 notes). The
// deterministic fixture gate (test/graph-recall.test.ts) proves the no-regression property
// now using these same metrics over an in-memory corpus.
import { z } from "zod";

export const GoldenQuerySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  query_text: z.string().min(1),
  seed_domain: z.string(),
  target_domain: z.string(),
  seed_paths: z.array(z.string()),
  target_paths: z.array(z.string()),
  bridge_paths: z.array(z.string()),
  description: z.string(),
});
export type GoldenQuery = z.infer<typeof GoldenQuerySchema>;

export const GoldenSetSchema = z.object({ queries: z.array(GoldenQuerySchema).min(1) });
export type GoldenSet = z.infer<typeof GoldenSetSchema>;

export interface RankedChunk {
  chunk_id: string;
  path: string;
  // Optional graph-aware metadata; populated by the graph adapter, undefined for baseline.
  source?: "seed" | "expansion" | "lexical" | "sparse";
  hop?: number;
  via_edge?: { type: string; source_path: string; provenance: string | null } | null;
  root_seed?: string | null;
}

export interface QueryMetrics {
  query_id: string;
  recall_at_10: number;
  mrr_at_10: number;
  /** THE-391 (additive): binary-relevance nDCG@10 over unique result paths — position-sensitive,
   *  unlike recall@10, so a ranking change that lifts an expected path from rank 9 to rank 1
   *  registers. The roadmap's ship gate metric (THE-171). */
  ndcg_at_10: number;
  bridge_recall: 0 | 1;
  expected_found_in_top10: number;
  expected_total: number;
  bridge_satisfied: boolean;
  result_paths_unique: number;
}

export interface AggregateMetrics {
  query_count: number;
  mean_recall_at_10: number;
  mean_mrr_at_10: number;
  mean_ndcg_at_10: number;
  bridge_recall_rate: number;
}

function uniquePathsInOrder(chunks: RankedChunk[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const c of chunks) {
    if (!seen.has(c.path)) {
      seen.add(c.path);
      ordered.push(c.path);
    }
  }
  return ordered;
}

export function computeQueryMetrics(query: GoldenQuery, results: RankedChunk[]): QueryMetrics {
  const allPaths = uniquePathsInOrder(results);
  const top10 = allPaths.slice(0, 10);
  const top10Set = new Set(top10);
  const allSet = new Set(allPaths);

  const expectedSet = new Set([...query.seed_paths, ...query.target_paths, ...query.bridge_paths]);
  const expectedFoundInTop10 = [...expectedSet].filter((p) => top10Set.has(p)).length;
  const expectedTotal = expectedSet.size;
  const recall_at_10 = expectedTotal > 0 ? expectedFoundInTop10 / expectedTotal : 0;

  let mrr_at_10 = 0;
  for (let i = 0; i < top10.length; i++) {
    const p = top10[i];
    if (p !== undefined && expectedSet.has(p)) {
      mrr_at_10 = 1 / (i + 1);
      break;
    }
  }

  // Binary-relevance nDCG@10: DCG over expected paths in the top-10 (gain 1, log2 position
  // discount) normalized by the ideal DCG for min(|expected|, 10) hits.
  let dcg = 0;
  for (let i = 0; i < top10.length; i++) {
    const p = top10[i];
    if (p !== undefined && expectedSet.has(p)) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  for (let i = 0; i < Math.min(expectedTotal, 10); i++) idcg += 1 / Math.log2(i + 2);
  const ndcg_at_10 = idcg > 0 ? dcg / idcg : 0;

  let bridge_satisfied: boolean;
  if (query.bridge_paths.length > 0) {
    bridge_satisfied = query.bridge_paths.some((p) => allSet.has(p));
  } else {
    const seedHit = query.seed_paths.some((p) => allSet.has(p));
    const targetHit = query.target_paths.some((p) => allSet.has(p));
    bridge_satisfied = seedHit && targetHit;
  }

  return {
    query_id: query.id,
    recall_at_10,
    mrr_at_10,
    ndcg_at_10,
    bridge_recall: bridge_satisfied ? 1 : 0,
    expected_found_in_top10: expectedFoundInTop10,
    expected_total: expectedTotal,
    bridge_satisfied,
    result_paths_unique: allPaths.length,
  };
}

export function aggregateMetrics(perQuery: QueryMetrics[]): AggregateMetrics {
  if (perQuery.length === 0) {
    return {
      query_count: 0,
      mean_recall_at_10: 0,
      mean_mrr_at_10: 0,
      mean_ndcg_at_10: 0,
      bridge_recall_rate: 0,
    };
  }
  const sums = perQuery.reduce(
    (acc, m) => ({
      recall: acc.recall + m.recall_at_10,
      mrr: acc.mrr + m.mrr_at_10,
      ndcg: acc.ndcg + m.ndcg_at_10,
      bridge: acc.bridge + m.bridge_recall,
    }),
    { recall: 0, mrr: 0, ndcg: 0, bridge: 0 },
  );
  const n = perQuery.length;
  return {
    query_count: n,
    mean_recall_at_10: sums.recall / n,
    mean_mrr_at_10: sums.mrr / n,
    mean_ndcg_at_10: sums.ndcg / n,
    bridge_recall_rate: sums.bridge / n,
  };
}
