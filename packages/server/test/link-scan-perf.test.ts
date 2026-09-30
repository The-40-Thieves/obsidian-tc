// Regression for the quadratic-time link scanning DoS class. The old MDLINK
// (`/(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g`) and WIKILINK (`/(!?)\[\[([^\]\n]+?)\]\]/g`)
// regexes re-scanned to end-of-line from every failed start, so a crafted 80 KB
// line of unclosed brackets measured 11+ seconds under Bun; the inline-code
// marking (a `ranges.some` per link/tag) was a second, independent O(n^2).
//
// Two kinds of assertion per shape: an absolute bound (generous, so CI load does not
// flake it while still sitting far below the multi-second blowup) and a SCALING check.
// The scaling check times four sizes (1x/2x/4x/8x) and fits a least-squares line to
// log(size) vs log(best time): the slope is the empirical exponent (linear ~ 1,
// quadratic ~ 2). A single 4x/1x ratio flaked at 6.3 against a cap of 6 on CI; a fit
// over four points, each well above timer noise, does not move with one noisy sample,
// and a quadratic path still lands near 2, past the 1.6 cap.
import { describe, expect, it } from "vitest";
import { scanLinks } from "../src/vault/link-scan";
import { extractLinks } from "../src/vault/links";
import { rewriteLinks } from "../src/vault/rewrite";
import { extractInlineTags } from "../src/vault/tags";

// The smallest size costs ~10 ms per pass, so timer and GC noise is a small fraction of it.
const BASE = 256 * 1024;
const SIZE_MULTIPLIERS = [1, 2, 4, 8];
// Absolute bound per 80 KB of input; the measured linear cost is ~3 ms per 80 KB.
const BOUND_MS_PER_80KB = 200;
// Linear ~ 1, quadratic ~ 2. Linear paths measured up to 1.44 under a saturated 4-core box (GC and
// cache pressure bend the 2 MB point upward); the restored quadratic marking measured 1.8-2.0.
const MAX_LOG_LOG_SLOPE = 1.6;
// A quadratic path can take minutes at 8x; once a size is this slow (and two sizes are in hand
// for the fit) the verdict is already decided, so sample it once and stop measuring larger sizes.
const SLOW_MS = 1000;
// Each case runs several 8x passes; keep it clear of vitest's 5 s default under CI load.
const CASE_TIMEOUT_MS = 60_000;

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

/** Time `run` over 1x..8x inputs of `unit`; assert the absolute bounds and the fitted scaling exponent. */
function expectLinear(unit: string, run: (input: string) => void): void {
  run(repeatTo(unit, BASE)); // warm-up: keep JIT compilation out of the timed samples
  const points: Array<{ bytes: number; ms: number }> = [];
  for (const k of SIZE_MULTIPLIERS) {
    const input = repeatTo(unit, k * BASE);
    const ms = bestMs(() => run(input));
    points.push({ bytes: input.length, ms });
    if (ms > SLOW_MS && points.length >= 2) break; // larger sizes would only cost minutes
  }
  const slope = logLogSlope(points);
  expect(
    slope,
    `${JSON.stringify(unit)} log-log slope over ${points.map((p) => `${p.bytes}B=${p.ms.toFixed(1)}ms`).join(", ")}`,
  ).toBeLessThan(MAX_LOG_LOG_SLOPE);
  for (const { bytes, ms } of points) {
    expect(ms, `${JSON.stringify(unit)} at ${bytes} bytes`).toBeLessThan(
      (BOUND_MS_PER_80KB * bytes) / (80 * 1024),
    );
  }
}

describe("link scanning stays linear under crafted adversarial input", {
  timeout: CASE_TIMEOUT_MS,
}, () => {
  it("MDLINK: many unclosed '[a](' via extractLinks", () => {
    expectLinear("[a](", (s) => extractLinks(s));
  });

  it("WIKILINK: many unclosed '[[a' via extractLinks", () => {
    expectLinear("[[a", (s) => extractLinks(s));
  });

  it("MDLINK via rewriteLinks: many unclosed '[a]('", () => {
    expectLinear("[a](", (s) => rewriteLinks(s, () => null));
  });

  it("WIKILINK via rewriteLinks: many unclosed '[[a'", () => {
    expectLinear("[[a", (s) => rewriteLinks(s, () => null));
  });

  it("rewriteLinks over many CLOSED links that the resolver rewrites", () => {
    expectLinear("[[a|b]] [c](d) ", (s) => rewriteLinks(s, () => "x"));
  });

  it("scanLinks (prune's single alternation): unclosed and closed shapes", () => {
    expectLinear("[a](", (s) => scanLinks(s));
    expectLinear("[[a", (s) => scanLinks(s));
    expectLinear("[[a]] [b](c) ", (s) => scanLinks(s));
  });

  it("unclosed backtick runs stay linear (already true; guard against a future regression)", () => {
    expectLinear("`x", (s) => extractLinks(s));
  });

  it("inline-code spans interleaved with links: extractLinks marks code in O(n log n)", () => {
    // 10 bytes per unit: one code span and one link. A `ranges.some` per link made this
    // quadratic (23 s at 640 KB).
    expectLinear("`a`[b](c) ", (s) => extractLinks(s));
    expectLinear("`a`[[b]] ", (s) => extractLinks(s));
  });

  it("inline-code spans interleaved with hashtags: extractInlineTags marks code in O(n log n)", () => {
    // 7 bytes per unit: one code span and one tag (measured 21.8 s at 448 KB before the fix).
    expectLinear("`a` #t ", (s) => extractInlineTags(s));
  });
});
