import type { Baseline, MetricClass, MetricMode, PerfReport } from "./report";

export interface GateViolation {
  key: string;
  actual: number;
  baseline: number;
  tol: number;
  mode: MetricMode;
  class: MetricClass;
}
export interface GateResult {
  hardFailures: GateViolation[];
  warnings: GateViolation[];
}

/** True when `actual` is worse than `baseline` by more than `tol`, honoring direction + mode.
 *  Improvements (better than baseline) never violate. */
function isViolation(actual: number, b: Baseline[string]): boolean {
  const limit = b.mode === "ratio" ? Math.abs(b.value) * b.tol : b.tol;
  const delta = actual - b.value; // >0 means actual is higher than baseline
  if (b.direction === "higher-worse") return delta > limit;
  if (b.direction === "lower-worse") return -delta > limit;
  return Math.abs(delta) > limit; // exact
}

export function evaluate(report: PerfReport, baseline: Baseline): GateResult {
  const hardFailures: GateViolation[] = [];
  const warnings: GateViolation[] = [];
  for (const s of report.samples) {
    const b = baseline[s.key];
    if (!b) continue; // metric present in report but not baselined yet — informational only
    if (!isViolation(s.value, b)) continue;
    const v: GateViolation = {
      key: s.key,
      actual: s.value,
      baseline: b.value,
      tol: b.tol,
      mode: b.mode,
      class: b.class,
    };
    (b.class === "hard" ? hardFailures : warnings).push(v);
  }
  return { hardFailures, warnings };
}
