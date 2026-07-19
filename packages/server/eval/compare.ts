// THE-399 — paired comparison of two eval runs. Usage:
//   bun eval/run.ts <config> --json a.json           # config A
//   bun eval/run.ts <config> --adaptive-rrf --json b.json   # config B
//   bun eval/compare.ts a.json b.json
// Pairs queries by id and reports Δ(B−A) with a permutation p + bootstrap CI per metric.
// THE-440/441: this tool now COMPUTES the ship gate instead of leaving it to hand-arithmetic —
// Benjamini-Hochberg at q=0.10 across the metric family, the Δ>−0.015 non-inferiority floor per
// metric, and the MDE at the paired n (so a null result is read as "no effect" vs "underpowered").
import { readFileSync } from "node:fs";
import type { EvalQueryResult } from "./run";
import {
  benjaminiHochberg,
  describeNonInferiority,
  describePaired,
  describePower,
  pairedPermutationTest,
} from "./stats";

const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) {
  process.stderr.write("usage: bun eval/compare.ts <a.json> <b.json>\n");
  process.exit(2);
}
interface Dump {
  flags?: string[];
  perQuery: EvalQueryResult[];
}
const a = JSON.parse(readFileSync(aPath, "utf8")) as Dump;
const b = JSON.parse(readFileSync(bPath, "utf8")) as Dump;
const byId = new Map(a.perQuery.map((q) => [q.id, q]));
const pairs = b.perQuery
  .map((qb) => ({ qa: byId.get(qb.id), qb }))
  .filter((p): p is { qa: EvalQueryResult; qb: EvalQueryResult } => p.qa !== undefined);
if (pairs.length === 0) {
  process.stderr.write("no overlapping query ids\n");
  process.exit(2);
}
process.stdout.write(
  `compare (graph side): A=${aPath} [${(a.flags ?? []).join(",") || "static"}]  B=${bPath} [${(b.flags ?? []).join(",") || "static"}]  paired n=${pairs.length}\n`,
);
const METRICS: Array<{ sel: (q: EvalQueryResult) => number; label: string }> = [
  { sel: (q) => q.graph.ndcg_at_10, label: "ΔnDCG@10 " },
  { sel: (q) => q.graph.recall_at_10, label: "Δrecall@10" },
  { sel: (q) => q.graph.mrr_at_10, label: "ΔMRR@10  " },
  { sel: (q) => q.graph.bridge_recall, label: "Δbridge  " },
];
const deltasByMetric = METRICS.map((m) => ({
  ...m,
  deltas: pairs.map(({ qa, qb }) => m.sel(qb) - m.sel(qa)),
}));

for (const { deltas, label } of deltasByMetric) {
  process.stdout.write(`  ${describePaired(deltas, label)}\n`);
}

// Benjamini-Hochberg across the metric family (q=0.10) — the policy the README used to
// say "apply by hand". A metric only counts as a significant move if it survives BH.
const pvals = deltasByMetric.map((m) => pairedPermutationTest(m.deltas));
const bh = benjaminiHochberg(pvals, 0.1);
process.stdout.write("\n  BH-FDR q=0.10 across the 4 metrics:\n");
deltasByMetric.forEach((m, i) => {
  const row = bh[i];
  process.stdout.write(
    `    ${m.label}  p=${(row?.p ?? 1).toFixed(4)}  crit=${(row?.critical ?? 0).toFixed(4)}  ${row?.rejected ? "SIGNIFICANT" : "ns"}\n`,
  );
});

// Non-inferiority floor (Δ>−0.015) per metric + MDE at the paired n on the primary metric.
process.stdout.write("\n  non-inferiority (ship floor Δ>−0.015):\n");
for (const { deltas, label } of deltasByMetric) {
  process.stdout.write(`    ${describeNonInferiority(deltas, label)}\n`);
}
const primary = deltasByMetric[0];
if (primary) process.stdout.write(`\n  ${describePower(primary.deltas, "power ΔnDCG@10  ")}\n`);
