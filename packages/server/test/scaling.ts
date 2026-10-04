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
  assertScalingFit(unit, points, boundMsPer80KB);
}

/** The verdict half of `expectLinear`, split out so it can be tested on fixed points: no clock. */
export function assertScalingFit(
  unit: string,
  points: Array<{ bytes: number; ms: number }>,
  boundMsPer80KB: number | null,
): void {
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

// ---- Deterministic variant: count WORK, not time -------------------------------------------------
//
// A clock cannot prove that a quadratic subject is refused. On a fast or quiet runner the quadratic
// pass at the sizes a test can afford is only milliseconds, under the timer's resolution (windows
// CPU times tick every ~15 ms), so the fitted slope can land under the cap and the NEGATIVE control
// passes by luck (windows-latest, merge group: `expected [Function] to throw an error`). A step
// count has no noise: the same input does the same work on every runner, every run.
//
// `expectLinearWork` fits the same log-log slope over the same four sizes, over the work `run`
// reports. Work comes from two places: `tick(n)` calls the subject makes itself (an instrumented
// model of an algorithm), and, with `countStringOps`, the String.prototype searches and reads a
// real, uninstrumented scanner performs (`indexOf` charged for the characters it walks, `slice`
// for the characters it copies, `startsWith`/`charCodeAt` for what they read). Regex-driven code
// does its work inside the regex engine, where neither is visible: that reads as ~0 work, and
// `minWorkPerByte` makes that fail loudly instead of passing vacuously.
const WORK_MAX_SLOPE = 1.3; // linear counts fit ~1.00; quadratic fits ~2.0
const WORK_SIZE_MULTIPLIERS = [1, 2, 4, 8];

export interface ExpectLinearWorkOptions {
  /** Size of the 1x input. Counts are exact, so this only has to be large enough to show the shape. */
  baseBytes: number;
  /** Floor on work per input byte at every size: the existence check for the counter itself. */
  minWorkPerByte?: number;
  /** Ceiling on work per input byte at every size: what fails a return of a large linear constant. */
  maxWorkPerByte?: number;
  /** Also charge the String.prototype searches and reads `run` performs (see above). */
  countStringOps?: boolean;
}

type StringMethods = {
  indexOf: typeof String.prototype.indexOf;
  slice: typeof String.prototype.slice;
  startsWith: typeof String.prototype.startsWith;
  charCodeAt: typeof String.prototype.charCodeAt;
};

/** Run `fn` with the String.prototype methods charged to `tick`; always restores the originals. */
function withStringOpsCounted(fn: () => void, tick: (n: number) => void): void {
  const proto = String.prototype;
  const orig: StringMethods = {
    indexOf: proto.indexOf,
    slice: proto.slice,
    startsWith: proto.startsWith,
    charCodeAt: proto.charCodeAt,
  };
  proto.indexOf = function (this: string, search: string, from?: number): number {
    const start = Math.max(0, from ?? 0);
    const found = orig.indexOf.call(this, search, start);
    tick(1 + (found === -1 ? this.length : found) - start);
    return found;
  };
  proto.slice = function (this: string, start?: number, end?: number): string {
    const out = orig.slice.call(this, start, end);
    tick(1 + out.length);
    return out;
  };
  proto.startsWith = function (this: string, search: string, pos?: number): boolean {
    tick(1 + search.length);
    return orig.startsWith.call(this, search, pos);
  };
  proto.charCodeAt = function (this: string, index?: number): number {
    tick(1);
    return orig.charCodeAt.call(this, index ?? 0);
  };
  try {
    fn();
  } finally {
    Object.assign(proto, orig);
  }
}

/** Work `run` performs on `input`, in the units described above. Deterministic. */
export function countWork(
  run: (input: string, tick: (n: number) => void) => void,
  input: string,
  countStringOps = false,
): number {
  let work = 0;
  const tick = (n: number): void => {
    work += n;
  };
  if (countStringOps) withStringOpsCounted(() => run(input, tick), tick);
  else run(input, tick);
  return work;
}

/** Assert the work `run` does over 1x..8x inputs of `unit` fits a slope under 1.3 (quadratic is 2). */
export function expectLinearWork(
  unit: string,
  run: (input: string, tick: (n: number) => void) => void,
  {
    baseBytes,
    minWorkPerByte = 0,
    maxWorkPerByte = Number.POSITIVE_INFINITY,
    countStringOps = false,
  }: ExpectLinearWorkOptions,
): void {
  const points: Array<{ bytes: number; work: number }> = [];
  for (const k of WORK_SIZE_MULTIPLIERS) {
    const input = repeatTo(unit, k * baseBytes);
    points.push({ bytes: input.length, work: countWork(run, input, countStringOps) });
  }
  const series = points.map((p) => `${p.bytes}B=${p.work}`).join(", ");
  const slope = logLogSlope(points.map((p) => ({ bytes: p.bytes, ms: p.work })));
  const label = `${JSON.stringify(unit)} work over ${series}`;
  if (process.env.SCALING_TRACE)
    process.stderr.write(`[scaling] ${label} slope=${slope.toFixed(3)}\n`);
  expect(slope, `${label}: log-log slope`).toBeLessThan(WORK_MAX_SLOPE);
  for (const { bytes, work } of points) {
    expect(work / bytes, `${label}: work per byte at ${bytes} bytes`).toBeGreaterThanOrEqual(
      minWorkPerByte,
    );
    expect(work / bytes, `${label}: work per byte at ${bytes} bytes`).toBeLessThanOrEqual(
      maxWorkPerByte,
    );
  }
}
