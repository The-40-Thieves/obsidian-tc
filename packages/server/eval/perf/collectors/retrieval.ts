import { performance } from "node:perf_hooks";
import { deterministicVector } from "../../../src/embeddings/fake";
import { graphSearch } from "../../../src/search/graph_search";
import type { VaultCtx } from "../harness";
import { LABELLED } from "../labelled";
import type { MetricSample } from "../report";

function dcg(hits: boolean[]): number {
  return hits.reduce((acc, hit, i) => acc + (hit ? 1 / Math.log2(i + 2) : 0), 0);
}

/** Families 8 (graph candidate counts per stage) + 9 (recall/nDCG per ms). Deterministic vault
 *  -> deterministic counts + relevance; per-ms is the warn-only latency figure. */
export async function collectRetrieval(vault: VaultCtx): Promise<MetricSample[]> {
  const stageCounts: Record<string, number> = { seed: 0, expand: 0, fused: 0 };
  let recallSum = 0;
  let ndcgSum = 0;
  let totalMs = 0;

  for (const q of LABELLED) {
    const t0 = performance.now();
    const results = (await graphSearch(vault.db, {
      query: q.query,
      queryVec: deterministicVector(q.query, 32),
      vaultId: vault.vaultId,
      finalTopK: 10,
      onStage: (stage, count) => {
        if (stage in stageCounts)
          stageCounts[stage] = Math.max(stageCounts[stage] as number, count);
      },
    })) as Array<{ path: string }>;
    totalMs += performance.now() - t0;

    const top = results.slice(0, 10).map((r) => q.relevantPaths.includes(r.path));
    const found = top.filter(Boolean).length;
    recallSum += q.relevantPaths.length > 0 ? found / q.relevantPaths.length : 0;
    const ideal = dcg(new Array(Math.min(10, q.relevantPaths.length)).fill(true));
    ndcgSum += ideal > 0 ? dcg(top) / ideal : 0;
  }

  const n = LABELLED.length;
  const recall = recallSum / n;
  const ndcg = ndcgSum / n;
  const perMs = totalMs > 0 ? ndcg / (totalMs / n) : 0;

  return [
    {
      key: "graph.candidates_seed",
      value: stageCounts.seed as number,
      unit: "count",
      class: "hard",
      direction: "exact",
    },
    {
      key: "graph.candidates_expand",
      value: stageCounts.expand as number,
      unit: "count",
      class: "hard",
      direction: "exact",
    },
    {
      key: "graph.candidates_fused",
      value: stageCounts.fused as number,
      unit: "count",
      class: "hard",
      direction: "exact",
    },
    {
      key: "retrieval.recall_at10",
      value: recall,
      unit: "ratio",
      class: "hard",
      direction: "lower-worse",
    },
    {
      key: "retrieval.ndcg_at10",
      value: ndcg,
      unit: "ratio",
      class: "hard",
      direction: "lower-worse",
    },
    {
      key: "retrieval.ndcg_per_ms",
      value: perMs,
      unit: "ratio",
      class: "warn",
      direction: "lower-worse",
    },
  ];
}
