export type MetricClass = "hard" | "warn";
export type MetricMode = "abs" | "ratio";
/** lower-worse: throughput/quality (a drop is a regression). higher-worse: latency/cost/bytes.
 *  exact: a deterministic count that must not move at all (tol is the allowed slack). */
export type Direction = "lower-worse" | "higher-worse" | "exact";

export interface MetricSample {
  key: string;
  value: number;
  unit: "count" | "per_s" | "ms" | "ratio" | "bytes" | "bool";
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
}

export function toMarkdown(report: PerfReport): string {
  const rows = report.samples
    .map((s) => `| ${s.key} | ${s.value} | ${s.unit} | ${s.class} | ${s.direction} |`)
    .join("\n");
  return `## perf report — ${report.scenario}\n\n| metric | value | unit | class | direction |\n|---|---|---|---|---|\n${rows}\n`;
}
