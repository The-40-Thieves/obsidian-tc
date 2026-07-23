export type MetricClass = "hard" | "warn";
export type MetricMode = "abs" | "ratio";
/** lower-worse: throughput/quality (a drop is a regression). higher-worse: latency/cost/bytes.
 *  exact: a deterministic count that must not move at all (tol is the allowed slack). */
export type Direction = "lower-worse" | "higher-worse" | "exact";

export interface MetricSample {
  key: string;
  value: number;
  // "mb" was missing, which is very likely how runtime.peak_rss_per_10k_mb ended up tagged
  // "count" while holding megabytes (THE-459). A unit that cannot be expressed gets mislabelled.
  unit: "count" | "per_s" | "ms" | "ratio" | "bytes" | "mb" | "bool";
  class: MetricClass;
  direction: Direction;
}

export interface BaselineEntry {
  value: number;
  tol: number;
  mode: MetricMode;
  class: MetricClass;
  direction: Direction;
}
export type Baseline = Record<string, BaselineEntry>;

export interface PerfReport {
  scenario: string;
  samples: MetricSample[];
  // THE-503: wall time (ms) of a fixed, scenario-independent CPU busy-loop, measured once at
  // process start by run.ts's CLI entry -- NOT set by runScenario() itself, which stays a pure
  // single-shot report builder. Used by the isolation layer (contention.ts / sample.ts) to detect
  // host contention across a batch of fresh-subprocess samples. Absent from reports produced by
  // calling runScenario() directly (e.g. existing unit tests), present in every CLI-produced
  // report.
  calibrationMs?: number;
}

export function toMarkdown(report: PerfReport): string {
  const rows = report.samples
    .map((s) => `| ${s.key} | ${s.value} | ${s.unit} | ${s.class} | ${s.direction} |`)
    .join("\n");
  return `## perf report — ${report.scenario}\n\n| metric | value | unit | class | direction |\n|---|---|---|---|---|\n${rows}\n`;
}
