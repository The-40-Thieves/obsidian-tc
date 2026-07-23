import { performance } from "node:perf_hooks";

// THE-503: host-contention detection for the perf harness's isolation layer.
//
// The motivating incident: a perf run overlapped the Vitest suite. Index/embedding throughput
// read ~51% below baseline and dispatch p99 was 16ms vs an isolated 1ms -- but the gate passed,
// because latency/throughput are warn-only and nothing was watching for the contention itself.
//
// This module answers one question: was the HOST busy with something else while we were
// measuring? It does that with a fixed, scenario-independent CPU busy-loop ("calibration") run
// once per isolated sample by isolate.ts, alongside the real scenario, and TWO complementary
// checks over the resulting series:
//
//  1. Relative (CV / max-over-median): a quiet host produces a tight, low-variance spread of
//     calibration times across samples; INTERMITTENT contention (comes and goes between samples,
//     or stalls one sample hard) shows up as high variance or an outlier. This needs no external
//     reference and can never rot.
//  2. Absolute (vs a committed reference): relative checks alone MISS a host that is UNIFORMLY
//     and CONTINUOUSLY busy for the whole run -- exactly the motivating incident, where the
//     Vitest suite ran the entire time the perf harness measured. Every sample gets slowed down
//     by roughly the same amount, so CV stays low even though every single number is wrong. This
//     was found empirically (not hypothesized) while validating this detector: an artificial,
//     constant 4-core CPU load produced cv=0.159 -- "clean" -- despite the calibration median
//     itself being roughly double a quiet run's. The absolute check catches that: it compares the
//     median against a deliberately-committed `referenceMs` (see run.ts's `--update-baseline`,
//     which refuses to refresh it under detected contention, same discipline as the metric
//     baseline) rather than a hardcoded constant, so it can be re-calibrated when CI hardware
//     changes instead of silently rotting.

/** Deterministic CPU-bound busy-work, sized to take ~20-40ms on a quiet host: long enough to be
 *  measurable well above timer noise, short enough not to meaningfully add to harness runtime
 *  across N samples. Not seeded off any scenario -- this exists ONLY to probe the host. */
const CALIBRATION_ITERATIONS = 40_000_000;

export function calibrate(iterations = CALIBRATION_ITERATIONS): number {
  const t0 = performance.now();
  let acc = 0;
  for (let i = 0; i < iterations; i++) {
    acc = (acc + Math.imul(i, 2654435761)) | 0;
  }
  // Reference `acc` so the loop can never be optimized away as dead code, without the value
  // itself meaning anything -- only the elapsed wall time is the measurement.
  if (Number.isNaN(acc)) throw new Error("unreachable: calibration accumulator is never NaN");
  return performance.now() - t0;
}

export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0
    ? ((s[mid - 1] as number) + (s[mid] as number)) / 2
    : (s[mid] as number);
}

/** Coefficient of variation: stddev / mean. 0 for a single sample or an all-zero series. */
export function coefficientOfVariation(nums: number[]): number {
  if (nums.length < 2) return 0;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  if (mean === 0) return 0;
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
  return Math.sqrt(variance) / mean;
}

export interface ContentionResult {
  contended: boolean;
  median: number;
  cv: number;
  raw: number[];
  reason?: string;
}

export interface ContentionOptions {
  /** CV above this flags contention (comes-and-goes noise across samples). Default 0.20. */
  cvThreshold?: number;
  /** max/median above this flags contention (one sample got stalled hard). Default 1.6. */
  maxOverMedianThreshold?: number;
  /** A committed "quiet host" calibration median (ms) to compare against, for detecting
   *  SUSTAINED/uniform contention that the relative checks above cannot see (see the module
   *  comment). Optional: absent, only the relative checks run. */
  referenceMs?: number;
  /** How far above `referenceMs` still counts as quiet, as a ratio. Default 0.5 (50% slower). */
  referenceTol?: number;
}

export function detectContention(
  calibrationMs: number[],
  opts?: ContentionOptions,
): ContentionResult {
  const cvThreshold = opts?.cvThreshold ?? 0.2;
  const maxOverMedianThreshold = opts?.maxOverMedianThreshold ?? 1.6;
  const referenceTol = opts?.referenceTol ?? 0.5;
  const med = median(calibrationMs);
  const cv = coefficientOfVariation(calibrationMs);
  const max = calibrationMs.length > 0 ? Math.max(...calibrationMs) : 0;
  const maxRatio = med > 0 ? max / med : 1;
  const cvBad = cv > cvThreshold;
  const maxBad = maxRatio > maxOverMedianThreshold;
  const referenceMs = opts?.referenceMs;
  const referenceBad = referenceMs !== undefined && med > referenceMs * (1 + referenceTol);
  return {
    contended: cvBad || maxBad || referenceBad,
    median: med,
    cv,
    raw: calibrationMs,
    reason: cvBad
      ? `calibration CV ${cv.toFixed(3)} exceeds threshold ${cvThreshold}`
      : maxBad
        ? `slowest calibration sample ${max.toFixed(1)}ms is ${maxRatio.toFixed(2)}x the median ${med.toFixed(1)}ms (threshold ${maxOverMedianThreshold}x)`
        : referenceBad
          ? `calibration median ${med.toFixed(1)}ms is more than ${(referenceTol * 100).toFixed(0)}% above the committed quiet-host reference ${(referenceMs as number).toFixed(1)}ms (sustained load, not just noise)`
          : undefined,
  };
}
