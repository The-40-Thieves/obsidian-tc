import type { Baseline, MetricClass, MetricMode, PerfReport } from "./report";

export interface GateViolation {
  key: string;
  /** The measured value. `NaN` when `reason` is "missing" — there was no measurement. */
  actual: number;
  baseline: number;
  tol: number;
  mode: MetricMode;
  class: MetricClass;
  /** "regression" = measured and worse than tolerance. "missing" = never measured at all. */
  reason: "regression" | "missing";
}

/** A metric that beat its baseline by so much that the baseline no longer describes the system. */
export interface StaleBaselineEntry {
  key: string;
  actual: number;
  baseline: number;
  /** How many times better than baseline (e.g. 113.9 for THE-486's 81,338 ms -> 714 ms). */
  factor: number;
}

export interface GateResult {
  hardFailures: GateViolation[];
  warnings: GateViolation[];
  stale: StaleBaselineEntry[];
}

/** An improvement this large means the committed baseline is no longer a description of the system.
 *  Deliberately generous: normal run-to-run noise and ordinary wins sit far below 2x, so this fires
 *  on step changes (THE-486 measured 113.9x) rather than chattering on every good commit. */
const STALE_IMPROVEMENT_FACTOR = 2;

/** True when `actual` is worse than `baseline` by more than `tol`, honoring direction + mode.
 *  Improvements (better than baseline) never violate. */
function isViolation(actual: number, b: Baseline[string]): boolean {
  const limit = b.mode === "ratio" ? Math.abs(b.value) * b.tol : b.tol;
  const delta = actual - b.value; // >0 means actual is higher than baseline
  if (b.direction === "higher-worse") return delta > limit;
  if (b.direction === "lower-worse") return -delta > limit;
  return Math.abs(delta) > limit; // exact
}

/** How many times BETTER than baseline `actual` is; <= 1 means no improvement. `exact` metrics have
 *  no improvement direction, so they never report one. */
function improvementFactor(actual: number, b: Baseline[string]): number {
  if (b.direction === "higher-worse") {
    // Cost metric (ms, bytes, txn count): lower is better.
    if (actual <= 0 || b.value <= 0) return 1;
    return b.value / actual;
  }
  if (b.direction === "lower-worse") {
    // Throughput metric: higher is better.
    if (actual <= 0 || b.value <= 0) return 1;
    return actual / b.value;
  }
  return 1;
}

/**
 * Compare a perf report against its baseline.
 *
 * THE-534 (the gate audit): this walks the BASELINE, not the report. That inversion is the whole
 * point. The previous version iterated `report.samples` and looked the baseline up, which made the
 * gate blind to anything the report failed to mention — and all three blind spots reported
 * "perf gate OK":
 *
 *   - an EMPTY report (harness produced nothing) had no samples to iterate, so zero violations;
 *   - a baselined metric that stopped being emitted was simply never visited;
 *   - a key renamed upstream fell through `if (!baseline[key]) continue` as "informational",
 *     so a 100x regression under a new name passed silently.
 *
 * Walking the baseline makes every baselined metric a claim that must be answered. A metric with no
 * sample is a violation of its own class ("missing"), which is what gives the gate a non-empty
 * floor: an empty report now fails every hard metric instead of passing.
 *
 * Improvements still never fail — blocking a good change would be worse than the bug. But a large
 * one is recorded in `stale`, because THE-486's 113x improvement passing "without comment" is how a
 * baseline silently stops describing the system, and the next reader cites it in a go/no-go
 * (THE-467 / THE-468 are gated on exactly these numbers).
 *
 * Samples present in the report but absent from the baseline remain informational — a new metric is
 * not yet a promise. The renamed-key case is caught from the other side: the OLD key goes missing.
 */
export function evaluate(report: PerfReport, baseline: Baseline): GateResult {
  const hardFailures: GateViolation[] = [];
  const warnings: GateViolation[] = [];
  const stale: StaleBaselineEntry[] = [];
  const byKey = new Map(report.samples.map((s) => [s.key, s]));

  for (const [key, b] of Object.entries(baseline)) {
    const sample = byKey.get(key);
    const bucket = b.class === "hard" ? hardFailures : warnings;

    if (sample === undefined) {
      bucket.push({
        key,
        actual: Number.NaN,
        baseline: b.value,
        tol: b.tol,
        mode: b.mode,
        class: b.class,
        reason: "missing",
      });
      continue;
    }

    if (isViolation(sample.value, b)) {
      bucket.push({
        key,
        actual: sample.value,
        baseline: b.value,
        tol: b.tol,
        mode: b.mode,
        class: b.class,
        reason: "regression",
      });
      continue;
    }

    const factor = improvementFactor(sample.value, b);
    if (factor >= STALE_IMPROVEMENT_FACTOR) {
      stale.push({ key, actual: sample.value, baseline: b.value, factor });
    }
  }

  return { hardFailures, warnings, stale };
}
