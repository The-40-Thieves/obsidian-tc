// The pre-run record for the multi-shape suite: per corpus, its shape statistics, its golden set (n,
// per-class counts, sha256) and the minimum detectable effect on nDCG@10 BEFORE any arm has run.
//
// An MDE needs a paired-delta spread (sigma_d) and no arm has run on the new corpora, so the plan
// borrows the spreads the harness already measured on the corpora that do have runs
// (docs/EVALUATION.md): 0.135 (evergreen, lenient labels), 0.198 (private multi-hop set) and 0.206
// (evergreen, strict labels). The headline MDE uses the widest, so it is the conservative one; a
// corpus whose real spread is narrower resolves smaller effects than stated here, never larger. Each
// run's own `power ΔnDCG@10` line then replaces the borrowed figure with a measured one, and the
// plan is the thing a result is read against, written down first.
//
// The power arithmetic is `powerReport` from eval/stats.ts (the function behind the harness's own
// `power ΔnDCG@10` line). It takes per-query deltas, so the planned spread is fed to it as a
// synthetic delta vector with exactly that sample standard deviation, rather than a second copy of
// the formula.
//
//   bun eval/corpora/suite-plan.ts --out plan.json [--markdown] \
//     --corpus name=<vault-root>:<golden> ...
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { GoldenSetSchema } from "../metrics";
import { powerReport } from "../stats";
import { type CorpusStats, computeCorpusStats } from "./corpus-stats";

/** Spreads of the paired nDCG@10 delta measured by the harness, from docs/EVALUATION.md. */
export const PLANNING_SIGMA_D = {
  "evergreen-lenient": 0.135,
  "private-multihop": 0.198,
  "evergreen-strict": 0.206,
} as const;

/** The widest measured spread: the conservative planning figure. */
export const HEADLINE_SIGMA_D = 0.206;

export interface PlannedPower {
  n: number;
  sigmaD: number;
  mde: number;
}

/**
 * MDE (alpha 0.05 two-sided, power 0.8) for `n` paired queries at spread `sigmaD`, through
 * `powerReport`. The delta vector is mean-zero with sample sd exactly `sigmaD`: pairs of +-sigmaD
 * plus one zero when n is odd (sample variance (n-1)*sigma^2/(n-1)), or +-sigmaD*sqrt((n-1)/n)
 * when n is even (n*a^2/(n-1) = sigma^2).
 */
export function plannedPower(n: number, sigmaD: number): PlannedPower {
  if (n < 2) throw new Error("planning needs at least 2 queries");
  const a = n % 2 === 0 ? sigmaD * Math.sqrt((n - 1) / n) : sigmaD;
  const deltas = Array.from({ length: n }, (_, i) =>
    n % 2 === 1 && i === n - 1 ? 0 : i % 2 === 0 ? a : -a,
  );
  const r = powerReport(deltas);
  return { n, sigmaD: r.sigmaD, mde: r.mde };
}

export interface SuiteEntry {
  name: string;
  stats: CorpusStats;
  golden: { n: number; sha256: string; perClass: Record<string, number> };
  /** MDE on nDCG@10 at each planning spread, widest (headline) first. */
  mde: Record<string, number>;
  headlineMde: number;
}

export function planEntry(name: string, vaultRoot: string, goldenPath: string): SuiteEntry {
  const raw = readFileSync(goldenPath, "utf8");
  const golden = GoldenSetSchema.parse(parseYaml(raw));
  const perClass: Record<string, number> = {};
  for (const q of golden.queries) {
    for (const c of q.categories ?? []) perClass[c] = (perClass[c] ?? 0) + 1;
  }
  const n = golden.queries.length;
  const mde: Record<string, number> = {};
  for (const [label, s] of Object.entries(PLANNING_SIGMA_D)) {
    mde[label] = Number(plannedPower(n, s).mde.toFixed(4));
  }
  return {
    name,
    stats: computeCorpusStats(vaultRoot),
    golden: { n, sha256: createHash("sha256").update(raw).digest("hex"), perClass },
    mde,
    headlineMde: Number(plannedPower(n, HEADLINE_SIGMA_D).mde.toFixed(4)),
  };
}

export function toMarkdown(entries: SuiteEntry[]): string {
  const rows = entries.map((e) => {
    const s = e.stats;
    return (
      `| ${e.name} | ${s.notes} | ${s.linksPerNote.mean} | ${(s.orphanRate * 100).toFixed(1)}% | ` +
      `${s.folderDepth.mean} (max ${s.folderDepth.max}) | ${s.bodyChars.mean} / ${s.bodyChars.median} | ` +
      `${(s.cjkShare * 100).toFixed(0)}% | ${e.golden.n} | ${e.headlineMde.toFixed(3)} |`
    );
  });
  return [
    "| corpus | notes | links per note | orphan rate | folder depth | body chars mean / median | CJK | n | MDE nDCG@10 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
  ].join("\n");
}

if ((import.meta as unknown as { main?: boolean }).main) {
  const argv = process.argv.slice(2);
  const out = argv[argv.indexOf("--out") + 1];
  const specs = argv.flatMap((a, i) => (argv[i - 1] === "--corpus" ? [a] : []));
  if (!out || specs.length === 0) {
    process.stderr.write(
      "usage: bun eval/corpora/suite-plan.ts --out plan.json [--markdown] --corpus name=<vault-root>:<golden> ...\n",
    );
    process.exit(2);
  }
  const entries = specs.map((s) => {
    const [name, rest] = s.split("=") as [string, string];
    const [root, golden] = rest.split(":") as [string, string];
    return planEntry(name, root, golden);
  });
  writeFileSync(
    out,
    `${JSON.stringify({ sigmaD: PLANNING_SIGMA_D, headlineSigmaD: HEADLINE_SIGMA_D, entries }, null, 2)}\n`,
  );
  if (argv.includes("--markdown")) process.stdout.write(`${toMarkdown(entries)}\n`);
}
