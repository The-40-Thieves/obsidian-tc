// THE-399 — statistics for the retrieval gate. Two primitives over PAIRED per-query deltas
// (config B minus config A on the same golden queries):
//
//   - pairedPermutationTest: exact-style sign-flip permutation test on the mean delta. nDCG
//     deltas are bounded, skewed, and n is small — t-tests are invalid and Wilcoxon tests the
//     median; the permutation test is the correct default (10k resamples).
//   - bootstrapMeanCI: percentile bootstrap CI of the mean delta, for effect-size reporting.
//
// Both use a seeded PRNG (mulberry32) so eval output is reproducible run-to-run. The SHIP RULE
// these numbers feed lives in eval/README.md.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Two-sided sign-flip permutation p-value for H0: mean(delta) = 0. */
export function pairedPermutationTest(
  deltas: number[],
  opts: { resamples?: number; seed?: number } = {},
): number {
  const n = deltas.length;
  if (n === 0) return 1;
  const resamples = opts.resamples ?? 10_000;
  const rng = mulberry32(opts.seed ?? 1337);
  const observed = Math.abs(mean(deltas));
  if (observed === 0) return 1;
  let atLeast = 0;
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (const d of deltas) s += rng() < 0.5 ? d : -d;
    if (Math.abs(s / n) >= observed) atLeast++;
  }
  // +1 smoothing keeps p > 0 (a permutation test cannot certify p = 0).
  return (atLeast + 1) / (resamples + 1);
}

/** Percentile bootstrap CI of the mean delta. */
export function bootstrapMeanCI(
  deltas: number[],
  opts: { resamples?: number; alpha?: number; seed?: number } = {},
): { lo: number; hi: number } {
  const n = deltas.length;
  if (n === 0) return { lo: 0, hi: 0 };
  const resamples = opts.resamples ?? 10_000;
  const alpha = opts.alpha ?? 0.05;
  const rng = mulberry32(opts.seed ?? 1337);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += deltas[Math.floor(rng() * n)] ?? 0;
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  const at = (q: number): number =>
    means[Math.min(means.length - 1, Math.max(0, Math.floor(q * means.length)))] ?? 0;
  return { lo: at(alpha / 2), hi: at(1 - alpha / 2) };
}

/** One-line report for a paired comparison: mean delta, 95% CI, permutation p. */
export function describePaired(deltas: number[], label: string): string {
  const m = mean(deltas);
  const { lo, hi } = bootstrapMeanCI(deltas);
  const p = pairedPermutationTest(deltas);
  return `${label}: Δmean ${m >= 0 ? "+" : ""}${m.toFixed(3)}  95% CI [${lo.toFixed(3)}, ${hi.toFixed(3)}]  permutation p=${p.toFixed(4)} (n=${deltas.length})`;
}
