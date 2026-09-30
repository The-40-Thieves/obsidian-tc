import { expect } from "vitest";

// Shared scaling assertion for the "this input shape must not go quadratic" (DoS / ReDoS) tests.
//
// A single time ratio between two sizes flakes: one noisy sample at either size moves it (4x/1x
// hit 6.3 against a cap of 6, and 3x/1x hit 5.74 against a cap of 5, on CI). `expectLinear` instead
// times four sizes (1x/2x/4x/8x) and fits a least-squares line to log(size) vs log(best time): the
// slope is the empirical exponent (linear ~ 1, quadratic ~ 2). A fit over four points, each well
// above timer noise, does not move with one noisy sample, and a quadratic path still lands near 2,
// past the 1.6 cap.
const DEFAULT_BASE_BYTES = 256 * 1024;
const SIZE_MULTIPLIERS = [1, 2, 4, 8];
// Absolute bound per 80 KB of input; the measured linear cost there is ~3 ms.
const DEFAULT_BOUND_MS_PER_80KB = 200;
// Linear ~ 1, quadratic ~ 2. Linear paths measured up to 1.44 under a saturated 4-core box (GC and
// cache pressure bend the largest point upward); a quadratic path measured 1.8-2.0.
const MAX_LOG_LOG_SLOPE = 1.6;
// A quadratic path can take minutes at 8x; once a size is this slow (and two sizes are in hand
// for the fit) the verdict is already decided, so sample it once and stop measuring larger sizes.
const SLOW_MS = 1000;

// CPU time (user + system) of this process, not wall clock: when another process competes for
// the cores, wall time inflates by whatever share the scheduler takes away, unevenly across
// sizes, while the CPU time this pass consumes does not (20/20 passes with two `tsc` runs
// saturating the box, where wall time failed 9/20). The paths under test are CPU-bound. Windows
// updates process CPU times only per scheduler tick (~15 ms), coarser than the smallest size, so
// it keeps the wall clock.
const USE_CPU_CLOCK = process.platform !== "win32";

function timeMs(fn: () => void): number {
  if (!USE_CPU_CLOCK) {
    const start = performance.now();
    fn();
    return performance.now() - start;
  }
  const start = process.cpuUsage();
  fn();
  const { user, system } = process.cpuUsage(start);
  return (user + system) / 1000;
}

// Best of `runs`, not the median: scheduler and GC noise on a shared CI box only ever ADDS time,
// so the minimum is the least-noisy estimate of the true cost (a median over a loaded box measured
// 3x spread across identical runs, the minimum did not).
function bestMs(fn: () => void, runs = 5): number {
  let best = timeMs(fn);
  if (best > SLOW_MS) return best;
  for (let i = 1; i < runs; i++) best = Math.min(best, timeMs(fn));
  return best;
}

/** Build a `bytes`-sized input from a repeated unit. */
function repeatTo(unit: string, bytes: number): string {
  return unit.repeat(Math.ceil(bytes / unit.length));
}

/** Least-squares slope of ln(time) against ln(size). Times are floored at 1 ms (timer resolution). */
function logLogSlope(points: Array<{ bytes: number; ms: number }>): number {
  const xs = points.map((p) => Math.log(p.bytes));
  const ys = points.map((p) => Math.log(Math.max(p.ms, 1)));
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += ((xs[i] ?? 0) - mx) * ((ys[i] ?? 0) - my);
    den += ((xs[i] ?? 0) - mx) ** 2;
  }
  return num / den;
}

export interface ExpectLinearOptions {
  /** Size of the 1x input. Pick it so the 1x pass costs ~10 ms or more (well above timer noise). */
  baseBytes?: number;
  /** Absolute ceiling per 80 KB of input, or `null` to assert the slope alone. */
  boundMsPer80KB?: number | null;
}

/** Time `run` over 1x..8x inputs of `unit`; assert the fitted scaling exponent and the absolute bounds. */
export function expectLinear(
  unit: string,
  run: (input: string) => void,
  {
    baseBytes = DEFAULT_BASE_BYTES,
    boundMsPer80KB = DEFAULT_BOUND_MS_PER_80KB,
  }: ExpectLinearOptions = {},
): void {
  run(repeatTo(unit, baseBytes)); // warm-up: keep JIT compilation out of the timed samples
  const points: Array<{ bytes: number; ms: number }> = [];
  for (const k of SIZE_MULTIPLIERS) {
    const input = repeatTo(unit, k * baseBytes);
    const ms = bestMs(() => run(input));
    points.push({ bytes: input.length, ms });
    if (ms > SLOW_MS && points.length >= 2) break; // larger sizes would only cost minutes
  }
  const slope = logLogSlope(points);
  const series = points.map((p) => `${p.bytes}B=${p.ms.toFixed(1)}ms`).join(", ");
  // SCALING_TRACE=1 prints every fit, for calibrating a new shape or reading a flake after the fact.
  if (process.env.SCALING_TRACE) {
    process.stderr.write(`[scaling] ${JSON.stringify(unit)} slope=${slope.toFixed(3)} ${series}\n`);
  }
  expect(slope, `${JSON.stringify(unit)} log-log slope over ${series}`).toBeLessThan(
    MAX_LOG_LOG_SLOPE,
  );
  if (boundMsPer80KB === null) return;
  for (const { bytes, ms } of points) {
    expect(ms, `${JSON.stringify(unit)} at ${bytes} bytes`).toBeLessThan(
      (boundMsPer80KB * bytes) / (80 * 1024),
    );
  }
}
