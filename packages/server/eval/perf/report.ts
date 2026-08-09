export type MetricClass = "hard" | "warn";
export type MetricMode = "abs" | "ratio";
/** lower-worse: throughput/quality (a drop is a regression). higher-worse: latency/cost/bytes.
 *  exact: a deterministic count that must not move at all (tol is the allowed slack). */
export type Direction = "lower-worse" | "higher-worse" | "exact";

export interface MetricSample {
  key: string;
  value: number;
  /**
   * THE-494: this metric is runtime-portable — deterministic and storage-agnostic, so it means the
   * same thing under Node + `node:sqlite` (where the sqlite-vec extension does NOT load and vector
   * search silently degrades to brute force) as it does under the gated bun + better-sqlite3 +
   * sqlite-vec path.
   *
   * OPT-IN ON PURPOSE. A new metric is non-portable until someone says otherwise, so the failure
   * mode of forgetting the flag is a Node parity run that reports one metric too FEW — visible and
   * harmless — rather than one that benchmarks a fallback path and calls the result parity. The
   * portable set is enumerated and floored in `perf-node-parity.test.ts`.
   */
  portable?: boolean;
  // "mb" was missing, which is very likely how runtime.peak_rss_per_10k_mb ended up tagged
  // "count" while holding megabytes (THE-459). A unit that cannot be expressed gets mislabelled.
  unit: "count" | "per_s" | "ms" | "ratio" | "bytes" | "mb" | "bool";
  class: MetricClass;
  direction: Direction;
}

/**
 * The `baseline.<scenario>.provenance.json` sidecar. Declared here, and used on BOTH the write side
 * (run.ts's `writeBaselineProvenance`) and the read side (its gate path), so the two cannot drift on
 * a field name — renaming `recordedExact` on one side stops compiling on the other. THE-754's whole
 * failure was a file quietly not meaning what a reader assumed, so the reader and writer agreeing is
 * a compile-time property here rather than a test that has to remember to exist.
 *
 * Only the fields a consumer reads are pinned; the writer adds more (host, mode, samples, …).
 */
export interface BaselineProvenance {
  scenario: string;
  mode: "isolated-median" | "single-shot";
  samples: number;
  measuredAtSha: string;
  treeDirty: boolean;
  measuredAt: string;
  host: { platform: string; arch: string; cpus: number };
  /** THE-754: every `exact` metric's value at record time. Optional because every baseline recorded
   *  before this shipped lacks it — and its absence means "not checked", never "coherent". */
  recordedExact?: Record<string, number>;
  calibration?: Record<string, { median: number; cv: number }>;
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
  // THE-584: wall time (ms) of a fixed write+fsync loop, measured in the same place and for the
  // same reason as calibrationMs. CPU and I/O are INDEPENDENT contention channels — two CI
  // recordings were 40-90% slow on every I/O-shaped metric while the CPU probe read clean — so a
  // recording is only trustworthy when both are quiet. Optional for the same reason as above.
  calibrationIoMs?: number;
  // THE-594: Spearman rank correlation (eval/perf/spearman.ts) between calibrateIo()'s round count
  // and its measured duration, computed once per single-shot invocation via
  // contention.ts's measureIoScalingRho(). Proves the I/O calibration probe measures real work
  // rather than a constant -- moved here (a harness-level invariant, gated on the MEDIAN across N
  // isolated samples in run.ts's `main()`) after the in-unit-suite version of this assertion
  // flaked on macOS AND windows-latest even after recalibration. Optional for the same reason as
  // calibrationMs/calibrationIoMs: absent from reports produced by calling runScenario() directly.
  ioScalingRho?: number;
}

export function toMarkdown(report: PerfReport): string {
  const rows = report.samples
    .map((s) => `| ${s.key} | ${s.value} | ${s.unit} | ${s.class} | ${s.direction} |`)
    .join("\n");
  return `## perf report — ${report.scenario}\n\n| metric | value | unit | class | direction |\n|---|---|---|---|---|\n${rows}\n`;
}
