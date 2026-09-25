// THE-1122 review (item 4) — paired non-inferiority comparison of two eval runs' BASELINE (dense
// retrieval) arm, not the graph arm eval/compare.ts hardcodes. Reuses eval/stats.ts's real
// statistical functions (pairedPermutationTest, pairedNonInferiority, powerReport) — the exact
// ones the ship gate itself uses — rather than a one-off inline calculation, so this script's
// numbers are provably the same methodology docs/EVALUATION.md's table cites elsewhere.
//
// KEEP THIS FILE. An earlier THE-1122 pass wrote an equivalent ad-hoc script directly under
// /data/obsidian-tc-eval/the-1122/ and then deleted it during "cleanup" along with the rest of
// that eval directory — the only record of how the model-selection table's numbers were produced
// went with it. This copy lives in the repo specifically so it does not happen again.
//
// Usage:
//   bun eval/run.ts <candidate-config.json> <golden.json> --json candidate.json
//   bun eval/run.ts <acceptance-config.json> <golden.json> --json acceptance.json
//   bun eval/compare-baseline.ts acceptance.json candidate.json
//
// Positional order is ACCEPTANCE first, CANDIDATE second — delta is candidate MINUS acceptance,
// matching "is the candidate non-inferior to the acceptance arm" (the ship question), not the
// other way round.
import { readFileSync } from "node:fs";
import type { EvalQueryResult } from "./run";
import {
  describeNonInferiority,
  describePower,
  pairedNonInferiority,
  pairedPermutationTest,
  powerReport,
} from "./stats";

const [acceptancePath, candidatePath] = process.argv.slice(2);
if (!acceptancePath || !candidatePath) {
  process.stderr.write(
    "usage: bun eval/compare-baseline.ts <acceptance.json> <candidate.json>\n" +
      "  (both produced by eval/run.ts --json against the SAME golden set)\n",
  );
  process.exit(2);
}

interface Dump {
  perQuery: EvalQueryResult[];
}
const acceptance = JSON.parse(readFileSync(acceptancePath, "utf8")) as Dump;
const candidate = JSON.parse(readFileSync(candidatePath, "utf8")) as Dump;

const byId = new Map(acceptance.perQuery.map((q) => [q.id, q]));
const pairs = candidate.perQuery
  .map((qc) => ({ qa: byId.get(qc.id), qc }))
  .filter((p): p is { qa: EvalQueryResult; qc: EvalQueryResult } => p.qa !== undefined);
if (pairs.length === 0) {
  process.stderr.write("no overlapping query ids between the two runs\n");
  process.exit(2);
}
if (pairs.length !== acceptance.perQuery.length || pairs.length !== candidate.perQuery.length) {
  process.stderr.write(
    `warning: paired n=${pairs.length}, but acceptance has ${acceptance.perQuery.length} and ` +
      `candidate has ${candidate.perQuery.length} — some query ids did not overlap\n`,
  );
}

process.stdout.write(
  `compare-baseline (dense-only arm): acceptance=${acceptancePath}  candidate=${candidatePath}  paired n=${pairs.length}\n`,
);

const METRICS: Array<{ sel: (q: EvalQueryResult) => number; label: string }> = [
  { sel: (q) => q.baseline.ndcg_at_10, label: "ΔnDCG@10  " },
  { sel: (q) => q.baseline.recall_at_10, label: "Δrecall@10" },
  { sel: (q) => q.baseline.mrr_at_10, label: "ΔMRR@10   " },
];
const deltasByMetric = METRICS.map((m) => ({
  ...m,
  // candidate minus acceptance — see module header for why this direction.
  deltas: pairs.map(({ qa, qc }) => m.sel(qc) - m.sel(qa)),
}));

process.stdout.write("\n  non-inferiority (ship floor Δ>−0.015):\n");
for (const { deltas, label } of deltasByMetric) {
  const sigmaD = powerReport(deltas).sigmaD;
  const p = pairedPermutationTest(deltas);
  process.stdout.write(
    `    ${describeNonInferiority(deltas, label)}  σ_d ${sigmaD.toFixed(3)}  permutation p=${p.toFixed(4)}\n`,
  );
}

const primary = deltasByMetric[0];
if (primary) process.stdout.write(`\n  ${describePower(primary.deltas, "power ΔnDCG@10  ")}\n`);

// Machine-readable summary, for a caller that wants the numbers without re-parsing the prose
// above (e.g. a future script assembling docs/EVALUATION.md's table programmatically).
const summary = Object.fromEntries(
  deltasByMetric.map(({ deltas, label }) => [
    label.trim(),
    {
      ...pairedNonInferiority(deltas),
      permutationP: pairedPermutationTest(deltas),
      sigmaD: powerReport(deltas).sigmaD,
      mde: powerReport(deltas).mde,
    },
  ]),
);
process.stdout.write(`\n${JSON.stringify(summary, null, 2)}\n`);
