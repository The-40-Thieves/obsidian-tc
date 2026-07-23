import { coefficientOfVariation, median } from "./contention";
import type { Direction, MetricClass, PerfReport } from "./report";

// THE-503: the isolation/statistics layer sitting ABOVE run.ts's single-shot `runScenario`.
//
// Part 1 requires: fresh-subprocess isolation per run, >=5 samples gated on the median (not a
// single observation), tracked coefficient of variation, and raw samples preserved in the
// artifact. This module is the pure aggregation half of that (subprocess orchestration lives in
// sample.ts); it is deliberately side-effect-free so it is trivially unit-testable without paying
// for real subprocess spawns.

export interface AggregatedSample {
  key: string;
  unit: PerfReport["samples"][number]["unit"];
  class: MetricClass;
  direction: Direction;
  /** Every raw observation across the N isolated runs, in run order. Never dropped -- THE-503
   *  requires the artifact to keep raw samples, not just the aggregate. */
  raw: number[];
  median: number;
  /** Coefficient of variation (stddev / mean) across `raw`. 0 for a single sample or no spread --
   *  expected for deterministic (hard/exact) metrics; informative for noisy warn-class latency. */
  cv: number;
}

export interface AggregatedReport {
  scenario: string;
  /** Number of isolated (fresh-subprocess) samples this aggregate was built from. */
  n: number;
  samples: AggregatedSample[];
}

/**
 * Combine N single-shot `PerfReport`s (same scenario, ideally each from a fresh subprocess) into
 * one aggregate: median + CV + the full raw series per metric key.
 *
 * Reports must agree on which keys they carry and each key's unit/class/direction -- that shape
 * is fixed by the collectors, not by runtime variance, so disagreement across samples means the
 * reports came from different scenarios/code paths and is a caller bug, not host noise.
 */
export function aggregate(reports: PerfReport[]): AggregatedReport {
  if (reports.length === 0) throw new Error("aggregate(): at least one report is required");
  const scenario = reports[0]?.scenario as string;
  const order: string[] = [];
  interface Accum {
    unit: AggregatedSample["unit"];
    class: MetricClass;
    direction: Direction;
    raw: number[];
  }
  const byKey = new Map<string, Accum>();

  for (const report of reports) {
    if (report.scenario !== scenario) {
      throw new Error(
        `aggregate(): scenario mismatch ("${report.scenario}" vs "${scenario}") -- samples must come from the same scenario`,
      );
    }
    for (const s of report.samples) {
      const existing = byKey.get(s.key);
      if (!existing) {
        byKey.set(s.key, { unit: s.unit, class: s.class, direction: s.direction, raw: [s.value] });
        order.push(s.key);
        continue;
      }
      if (
        existing.unit !== s.unit ||
        existing.class !== s.class ||
        existing.direction !== s.direction
      ) {
        throw new Error(
          `aggregate(): metric "${s.key}" shape changed across samples (unit/class/direction must be constant)`,
        );
      }
      existing.raw.push(s.value);
    }
  }

  const samples: AggregatedSample[] = order.map((key) => {
    const e = byKey.get(key) as Accum;
    return {
      key,
      unit: e.unit,
      class: e.class,
      direction: e.direction,
      raw: e.raw,
      median: median(e.raw),
      cv: coefficientOfVariation(e.raw),
    };
  });

  return { scenario, n: reports.length, samples };
}

/** Project an AggregatedReport down to a PerfReport keyed on each metric's MEDIAN, so the
 *  existing (unchanged) gate.evaluate() can compare it against a baseline exactly as it does a
 *  single-shot report. */
export function toMedianReport(agg: AggregatedReport): PerfReport {
  return {
    scenario: agg.scenario,
    samples: agg.samples.map((s) => ({
      key: s.key,
      value: s.median,
      unit: s.unit,
      class: s.class,
      direction: s.direction,
    })),
  };
}

export interface HardInstability {
  key: string;
  raw: number[];
}

/**
 * Hard-class metrics (correctness invariants: counts, booleans, ratios) are, by construction,
 * seed-deterministic -- they must not depend on wall-clock or host load at all. If one varies
 * across the N isolated samples, that is NOT a baseline-tolerance regression (gate.evaluate's
 * job); it is evidence the "deterministic" assumption itself broke -- either genuine code
 * nondeterminism or a corrupted run -- and must be surfaced as its own hard failure, distinct
 * from and prior to the baseline comparison. This is the isolation layer's half of "separate
 * correctness gates from machine-performance gates": correctness must fail hard on ANY
 * disagreement, not just on drift past a tolerance.
 */
export function checkHardStability(agg: AggregatedReport): HardInstability[] {
  const out: HardInstability[] = [];
  for (const s of agg.samples) {
    if (s.class !== "hard") continue;
    if (new Set(s.raw).size > 1) out.push({ key: s.key, raw: s.raw });
  }
  return out;
}
