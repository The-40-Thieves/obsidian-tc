// Paired arm-against-control report for the multi-shape suite (part 2). Reads the `run.ts --json`
// artifacts of one corpus (`<corpus>--<arm>.json`, `default` being the control) and applies the rule
// written down in PREREGISTRATION-part2.md, mechanically:
//
//   WIN   delta > 0, Benjamini-Hochberg significant (q 0.10, one family per corpus), delta >= MDE
//   LOSS  delta < 0, Benjamini-Hochberg significant, delta <= -MDE
//   TIE   everything else; "sig, sub-MDE" marks a raw p < 0.05 with |delta| under the MDE
//
// MDE is the preregistered headline figure per corpus from `suite-plan.json`, never the arm's own
// spread (that one is reported, descriptively). Every statistic is the harness's own (`stats.ts`);
// this file only pairs, applies the rule and formats.
//
//   bun eval/corpora/matrix-report.ts --dir <artifacts> --out matrix.json [--markdown matrix.md]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { QueryMetrics } from "../metrics";
import {
  benjaminiHochberg,
  bootstrapMeanCI,
  pairedNonInferiority,
  pairedPermutationTest,
  powerReport,
} from "../stats";

export interface ArtifactQuery {
  id: string;
  baseline: QueryMetrics;
  graph: QueryMetrics;
}
export interface Artifact {
  flags?: string[];
  perQuery: ArtifactQuery[];
}

export type Verdict = "WIN" | "LOSS" | "TIE";

export interface MetricDelta {
  mean: number;
  ciLo: number;
  ciHi: number;
  p: number;
  lower95: number;
  nonInferior: boolean;
  /** Queries scored; for the bridge metric, only those that declare bridge notes. */
  n: number;
}

export interface PairedResult {
  n: number;
  ndcg: MetricDelta;
  recall: MetricDelta;
  mrr: MetricDelta;
  bridgeNdcg: MetricDelta | null;
  sigmaD: number;
  mdeRealized: number;
  /** Queries on which at least one of the four per-query metrics differs. */
  changed: number;
  meanA: number;
  meanB: number;
}

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

function metricDelta(deltas: number[]): MetricDelta {
  const ci = bootstrapMeanCI(deltas);
  const ni = pairedNonInferiority(deltas);
  return {
    mean: mean(deltas),
    ciLo: ci.lo,
    ciHi: ci.hi,
    p: pairedPermutationTest(deltas),
    lower95: ni.lowerBound,
    nonInferior: ni.nonInferior,
    n: deltas.length,
  };
}

type Pick = (q: ArtifactQuery) => QueryMetrics;

/** B minus A over the queries both artifacts hold, paired by id. `sideA`/`sideB` choose which
 *  recorded side of each artifact is compared: graph against graph for an arm against the control,
 *  baseline against graph for the control's own default-stack comparison. */
export function pairSides(a: Artifact, sideA: Pick, b: Artifact, sideB: Pick): PairedResult {
  const byId = new Map(a.perQuery.map((q) => [q.id, q]));
  const pairs = b.perQuery.flatMap((qb) => {
    const qa = byId.get(qb.id);
    return qa ? [{ ma: sideA(qa), mb: sideB(qb) }] : [];
  });
  if (pairs.length === 0) throw new Error("no overlapping query ids");
  const nd = pairs.map(({ ma, mb }) => mb.ndcg_at_10 - ma.ndcg_at_10);
  const bridge = pairs.flatMap(({ ma, mb }) =>
    ma.bridge_ndcg_at_10 !== null && mb.bridge_ndcg_at_10 !== null
      ? [mb.bridge_ndcg_at_10 - ma.bridge_ndcg_at_10]
      : [],
  );
  const pw = powerReport(nd);
  return {
    n: pairs.length,
    ndcg: metricDelta(nd),
    recall: metricDelta(pairs.map(({ ma, mb }) => mb.recall_at_10 - ma.recall_at_10)),
    mrr: metricDelta(pairs.map(({ ma, mb }) => mb.mrr_at_10 - ma.mrr_at_10)),
    bridgeNdcg: bridge.length > 0 ? metricDelta(bridge) : null,
    sigmaD: pw.sigmaD,
    mdeRealized: pw.mde,
    changed: pairs.filter(
      ({ ma, mb }) =>
        ma.ndcg_at_10 !== mb.ndcg_at_10 ||
        ma.recall_at_10 !== mb.recall_at_10 ||
        ma.mrr_at_10 !== mb.mrr_at_10 ||
        ma.bridge_recall !== mb.bridge_recall,
    ).length,
    meanA: mean(pairs.map(({ ma }) => ma.ndcg_at_10)),
    meanB: mean(pairs.map(({ mb }) => mb.ndcg_at_10)),
  };
}

export const graphSide: Pick = (q) => q.graph;
export const baselineSide: Pick = (q) => q.baseline;

export interface Judged {
  verdict: Verdict;
  /** Raw p under 0.05 with |delta| under the MDE: significant but too small to call. */
  subMdeSignificant: boolean;
}

/** The preregistered rule. `significant` is the Benjamini-Hochberg decision for the arm's family
 *  (or the raw p < 0.05 for a family of one, the default-stack comparison). */
export function judge(delta: number, p: number, significant: boolean, mde: number): Judged {
  const verdict: Verdict =
    significant && delta >= mde ? "WIN" : significant && delta <= -mde ? "LOSS" : "TIE";
  return { verdict, subMdeSignificant: verdict === "TIE" && p < 0.05 && Math.abs(delta) < mde };
}

export interface ArmRow {
  arm: string;
  result: PairedResult;
  bh: boolean;
  verdict: Verdict;
  subMdeSignificant: boolean;
}

export interface CorpusReport {
  corpus: string;
  mde: number;
  defaultStack: (PairedResult & Judged) | null;
  arms: ArmRow[];
}

/** One corpus: the control's own graph-against-dense comparison, then each arm against the
 *  control with BH applied across the arms. */
export function reportCorpus(
  corpus: string,
  mde: number,
  control: Artifact,
  arms: Array<{ arm: string; artifact: Artifact }>,
): CorpusReport {
  const own = pairSides(control, baselineSide, control, graphSide);
  const defaultStack = { ...own, ...judge(own.ndcg.mean, own.ndcg.p, own.ndcg.p < 0.05, mde) };
  const results = arms.map(({ arm, artifact }) => ({
    arm,
    result: pairSides(control, graphSide, artifact, graphSide),
  }));
  const bh = benjaminiHochberg(
    results.map((r) => r.result.ndcg.p),
    0.1,
  );
  const rows = results.map((r, i) => {
    const sig = bh[i]?.rejected ?? false;
    return { ...r, bh: sig, ...judge(r.result.ndcg.mean, r.result.ndcg.p, sig, mde) };
  });
  return { corpus, mde, defaultStack, arms: rows };
}

const sgn = (x: number, d = 3): string => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
const pfmt = (p: number): string => (p < 0.001 ? "<0.001" : p.toFixed(3));
const cell = (m: MetricDelta | null): string => (m ? `${sgn(m.mean)} (p ${pfmt(m.p)})` : "n/a");

/** Markdown table for one corpus: one row per arm, the default-stack row first. */
export function formatCorpusTable(r: CorpusReport): string {
  const head =
    "| arm | nDCG@10 control to arm | delta nDCG@10, 95% CI | p | BH | delta recall@10 | delta MRR@10 | delta bridge nDCG@10 (n) | queries changed | verdict |\n" +
    "| --- | --- | --- | ---: | --- | --- | --- | --- | ---: | --- |\n";
  const line = (
    name: string,
    x: PairedResult,
    bh: string,
    v: Verdict,
    sub: boolean,
    nd: string,
  ): string =>
    `| ${name} | ${nd} | ${sgn(x.ndcg.mean)} [${sgn(x.ndcg.ciLo)}, ${sgn(x.ndcg.ciHi)}] | ${pfmt(x.ndcg.p)} | ${bh} | ${cell(x.recall)} | ${cell(x.mrr)} | ${x.bridgeNdcg ? `${cell(x.bridgeNdcg)} (${x.bridgeNdcg.n})` : "n/a"} | ${x.changed} | ${v}${sub ? " (sig, sub-MDE)" : ""} |\n`;
  const d = r.defaultStack;
  const rows = [
    d
      ? line(
          "default stack, graph vs dense",
          d,
          d.ndcg.p < 0.05 ? "p<0.05" : "ns",
          d.verdict,
          d.subMdeSignificant,
          `${d.meanA.toFixed(4)} to ${d.meanB.toFixed(4)}`,
        )
      : "",
    ...r.arms.map((a) =>
      line(
        a.arm,
        a.result,
        a.bh ? "yes" : "no",
        a.verdict,
        a.subMdeSignificant,
        `${a.result.meanA.toFixed(4)} to ${a.result.meanB.toFixed(4)}`,
      ),
    ),
  ];
  return `${head}${rows.join("")}`;
}

function readArtifact(path: string): Artifact {
  return JSON.parse(readFileSync(path, "utf8")) as Artifact;
}

/** `<corpus>--<arm>.json` files of one directory, grouped by corpus. */
export function discover(dir: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const f of readdirSync(dir)) {
    const m = /^(.+?)--(.+)\.json$/.exec(f);
    if (!m?.[1] || !m[2]) continue;
    const arms = out.get(m[1]) ?? new Map<string, string>();
    arms.set(m[2], join(dir, f));
    out.set(m[1], arms);
  }
  return out;
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if ((import.meta as unknown as { main?: boolean }).main) {
  const dir = flag("--dir");
  const out = flag("--out");
  const plan = flag("--plan") ?? join(import.meta.dirname, "suite-plan.json");
  if (!dir || !out) {
    process.stderr.write(
      "usage: bun eval/corpora/matrix-report.ts --dir <artifacts> --out matrix.json [--markdown m.md] [--plan suite-plan.json]\n",
    );
    process.exit(2);
  }
  const mdes = new Map(
    (
      JSON.parse(readFileSync(plan, "utf8")) as {
        entries: Array<{ name: string; headlineMde: number }>;
      }
    ).entries.map((e) => [e.name, e.headlineMde]),
  );
  const reports: CorpusReport[] = [];
  for (const [corpus, files] of [...discover(dir)].sort()) {
    const control = files.get("default");
    const mde = mdes.get(corpus);
    if (!control || mde === undefined) continue;
    const arms = [...files]
      .filter(([arm]) => arm !== "default")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([arm, path]) => ({ arm, artifact: readArtifact(path) }));
    reports.push(reportCorpus(corpus, mde, readArtifact(control), arms));
  }
  writeFileSync(out, JSON.stringify(reports, null, 2));
  const md = flag("--markdown");
  const text = reports
    .map((r) => `### ${r.corpus} (MDE ${r.mde.toFixed(4)})\n\n${formatCorpusTable(r)}`)
    .join("\n");
  if (md) writeFileSync(md, text);
  process.stdout.write(`${text}\n`);
}
