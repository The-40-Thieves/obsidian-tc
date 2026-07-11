// THE-399 — paired comparison of two eval runs. Usage:
//   bun eval/run.ts <config> --json a.json           # config A
//   bun eval/run.ts <config> --adaptive-rrf --json b.json   # config B
//   bun eval/compare.ts a.json b.json
// Pairs queries by id and reports Δ(B−A) with a permutation p + bootstrap CI per metric.
// Multiple-comparison policy (documented in eval/README.md): when a session tests many configs,
// apply Benjamini-Hochberg at q=0.10 across the reported p-values by hand — this tool reports
// RAW p-values only.
import { readFileSync } from "node:fs";
import type { EvalQueryResult } from "./run";
import { describePaired } from "./stats";

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
const metric = (sel: (q: EvalQueryResult) => number, label: string): void => {
  const deltas = pairs.map(({ qa, qb }) => sel(qb) - sel(qa));
  process.stdout.write(`  ${describePaired(deltas, label)}\n`);
};
metric((q) => q.graph.ndcg_at_10, "ΔnDCG@10 ");
metric((q) => q.graph.recall_at_10, "Δrecall@10");
metric((q) => q.graph.mrr_at_10, "ΔMRR@10  ");
metric((q) => q.graph.bridge_recall, "Δbridge  ");
