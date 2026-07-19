// THE-441 — score the Qwen3-Reranker-4B reranked orders against the golden set and gate them
// against the champion under the recalibrated ship rule (paired permutation + BH-FDR, the
// Δ>−0.015 non-inferiority floor, and the MDE/power line so a null is read as "no effect" vs
// "underpowered"). Closes the one-shot loop: export-rerank-pools.ts → qwen3_rerank.py → this.
//
// Usage: bun eval/score-reranked.ts <golden.yaml> <reranked.json> <champion-baseline.json>
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  aggregateMetrics,
  computeQueryMetrics,
  GoldenSetSchema,
  type RankedChunk,
} from "./metrics";
import type { EvalQueryResult } from "./run";
import {
  benjaminiHochberg,
  describeNonInferiority,
  describePaired,
  describePower,
  pairedPermutationTest,
} from "./stats";

const [goldenPath, rerankedPath, championPath] = process.argv.slice(2);
if (!goldenPath || !rerankedPath || !championPath) {
  process.stderr.write(
    "usage: bun eval/score-reranked.ts <golden.yaml> <reranked.json> <champion-baseline.json>\n",
  );
  process.exit(2);
}

const golden = GoldenSetSchema.parse(parseYaml(readFileSync(goldenPath, "utf8")));
const reranked = JSON.parse(readFileSync(rerankedPath, "utf8")) as {
  model: string;
  reranked: Array<{ id: string; order: Array<{ chunk_id: string; path: string }> }>;
};
const champion = JSON.parse(readFileSync(championPath, "utf8")) as { perQuery: EvalQueryResult[] };

const goldenById = new Map(golden.queries.map((q) => [q.id, q]));
const champById = new Map(champion.perQuery.map((p) => [p.id, p]));
const norm = (p: string): string => p.replace(/\\/g, "/");

// Pair reranked queries with the champion's graph-side metrics on the same ids.
const rerankMetrics = [];
const champMetrics = [];
for (const r of reranked.reranked) {
  const q = goldenById.get(r.id);
  const c = champById.get(r.id);
  if (!q || !c) continue;
  const hits: RankedChunk[] = r.order.map((o) => ({ chunk_id: o.chunk_id, path: norm(o.path) }));
  const normQ = {
    ...q,
    seed_paths: q.seed_paths.map(norm),
    target_paths: q.target_paths.map(norm),
    bridge_paths: q.bridge_paths.map(norm),
  };
  rerankMetrics.push(computeQueryMetrics(normQ, hits));
  champMetrics.push(c.graph);
}

if (rerankMetrics.length === 0) {
  process.stderr.write("no overlapping query ids between reranked, golden, and champion\n");
  process.exit(2);
}

const rr = aggregateMetrics(rerankMetrics);
const ch = aggregateMetrics(champMetrics);
const n = rerankMetrics.length;
process.stdout.write(`\nTHE-441 Qwen3-Reranker-4B kill-shot — ${reranked.model}, n=${n}\n\n`);
process.stdout.write(`${"metric".padEnd(16)}champion  reranked\n`);
const row = (label: string, a: number, b: number): void =>
  process.stdout.write(`${label.padEnd(16)}${a.toFixed(3)}     ${b.toFixed(3)}\n`);
row("nDCG@10", ch.mean_ndcg_at_10, rr.mean_ndcg_at_10);
row("recall@10", ch.mean_recall_at_10, rr.mean_recall_at_10);
row("MRR@10", ch.mean_mrr_at_10, rr.mean_mrr_at_10);
row("bridge recall", ch.bridge_recall_rate, rr.bridge_recall_rate);
row("bridge nDCG", ch.mean_bridge_ndcg_at_10, rr.mean_bridge_ndcg_at_10);

// Paired deltas (reranked − champion) on the SAME queries, per metric.
const dN = rerankMetrics.map((m, i) => m.ndcg_at_10 - (champMetrics[i]?.ndcg_at_10 ?? 0));
const dR = rerankMetrics.map((m, i) => m.recall_at_10 - (champMetrics[i]?.recall_at_10 ?? 0));
const dM = rerankMetrics.map((m, i) => m.mrr_at_10 - (champMetrics[i]?.mrr_at_10 ?? 0));
process.stdout.write("\nship gate vs champion (paired, recalibrated rule):\n");
process.stdout.write(`  ${describePaired(dN, "ΔnDCG@10 ")}\n`);
process.stdout.write(`  ${describePaired(dR, "Δrecall@10")}\n`);
process.stdout.write(`  ${describePaired(dM, "ΔMRR@10  ")}\n`);

// BH-FDR across the 3 primary metrics + non-inferiority floor + MDE/power on nDCG.
const bh = benjaminiHochberg(
  [dN, dR, dM].map((d) => pairedPermutationTest(d)),
  0.1,
);
process.stdout.write("\n  BH-FDR q=0.10:\n");
["ΔnDCG@10", "Δrecall@10", "ΔMRR@10"].forEach((lbl, i) => {
  process.stdout.write(
    `    ${lbl.padEnd(11)} p=${(bh[i]?.p ?? 1).toFixed(4)}  ${bh[i]?.rejected ? "SIGNIFICANT" : "ns"}\n`,
  );
});
process.stdout.write("\n  non-inferiority (floor Δ>−0.015):\n");
process.stdout.write(`    ${describeNonInferiority(dN, "ΔnDCG@10 ")}\n`);
process.stdout.write(`    ${describeNonInferiority(dR, "Δrecall@10")}\n`);
process.stdout.write(`\n  ${describePower(dN, "power ΔnDCG@10  ")}\n`);

// Falsification verdict (the ticket's frame): a correct 4B reranker on a deep pool that cannot
// clear the floor settles the reranking lane as dead for this stack.
const niN = describeNonInferiority(dN, "").includes("NON-INFERIOR");
const sigWin = (bh[0]?.rejected ?? false) && dN.reduce((a, b) => a + b, 0) > 0;
process.stdout.write(
  `\nverdict: ${
    sigWin
      ? "reranker WINS on nDCG@10 (survives BH) — reranking lane is LIVE"
      : niN
        ? "no significant win; within non-inferiority floor — inconclusive at this n (see power line)"
        : "reranker FAILS the non-inferiority floor — reranking is settled-dead for this stack"
  }\n`,
);
