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

// ─────────────────────────────────────────────────────────────────────────────
// THE-440/THE-441 eval recalibration. The ship gate in eval/README.md needs three
// numbers the harness never computed: the minimal detectable effect at the current n
// (so "the eval can't resolve Δ<X" is measured, not asserted), the non-inferiority
// verdict against the Δ>−0.015 floor (one-sided, not eyeballed off a two-sided CI),
// and the Benjamini-Hochberg decision across a config sweep (was "by hand" per the
// README). All are pure functions over the same paired per-query deltas.

/** Sample standard deviation (n−1). 0 for n<2. */
export function sampleStdev(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  const ss = xs.reduce((a, b) => a + (b - m) * (b - m), 0);
  return Math.sqrt(ss / (n - 1));
}

// Normal quantiles for the standard power formula. α=.05 two-sided → z=1.95996;
// power .8 → z=0.84162, power .9 → z=1.28155. Table lookup keeps the module
// dependency-free (no erf-inverse) and matches what the ship rule cites.
const Z_ALPHA_2 = 1.959964; // two-sided α=0.05
const Z_POWER: Record<string, number> = { "0.8": 0.841621, "0.9": 1.281552 };

export interface PowerReport {
  n: number;
  /** SD of the PAIRED per-query deltas — the quantity that sets the floor. */
  sigmaD: number;
  /** Standard error of the mean paired delta. */
  se: number;
  /** Minimal detectable effect at this n (α, power). */
  mde: number;
  alpha: number;
  power: number;
  /** For each target effect: golden-set size needed to detect it at (α, power). */
  nNeeded: Array<{ delta: number; n: number }>;
}

/**
 * Power analysis for a paired mean-difference test on per-query deltas.
 * MDE = (z_{α/2}+z_β)·σ_d/√n ; n_needed(Δ) = ⌈(z_{α/2}+z_β)²·σ_d²/Δ²⌉.
 * This is the exact relation the eval/README ship rule quotes (n≈126 detects Δ=0.05).
 */
export function powerReport(
  deltas: number[],
  opts: { alpha?: number; power?: number; targets?: number[] } = {},
): PowerReport {
  const n = deltas.length;
  const alpha = opts.alpha ?? 0.05;
  const power = opts.power ?? 0.8;
  const zA = Z_ALPHA_2; // fixed at the α=.05 two-sided operating point the gate uses
  const zB = Z_POWER[power.toFixed(1)] ?? Z_POWER["0.8"] ?? 0.841621;
  const sigmaD = sampleStdev(deltas);
  const se = n > 0 ? sigmaD / Math.sqrt(n) : 0;
  const mde = (zA + zB) * se;
  const k = (zA + zB) * (zA + zB) * sigmaD * sigmaD;
  const targets = opts.targets ?? [0.05, 0.03, 0.02];
  const nNeeded = targets.map((delta) => ({
    delta,
    n: delta > 0 ? Math.ceil(k / (delta * delta)) : Number.POSITIVE_INFINITY,
  }));
  return { n, sigmaD, se, mde, alpha, power, nNeeded };
}

export function describePower(deltas: number[], label: string): string {
  const r = powerReport(deltas);
  const need = r.nNeeded.map((t) => `Δ=${t.delta.toFixed(2)}→n≥${t.n}`).join("  ");
  return (
    `${label}: σ_d ${r.sigmaD.toFixed(3)}  SE ${r.se.toFixed(4)}  ` +
    `MDE@n=${r.n} ${r.mde.toFixed(3)} (α=${r.alpha}, power=${r.power})  |  ${need}`
  );
}

export interface NonInferiorityResult {
  mean: number;
  margin: number;
  /** One-sided (1−α) lower confidence bound on the mean delta (bootstrap). */
  lowerBound: number;
  /** True iff the lower bound clears the margin — i.e. B is non-inferior to A. */
  nonInferior: boolean;
  alpha: number;
}

/**
 * One-sided non-inferiority test for a paired delta (B−A) against a floor `margin`
 * (default −0.015, the ship rule's per-metric non-inferiority floor). B is declared
 * non-inferior when the one-sided (1−α) bootstrap lower bound on the mean delta is
 * above the margin. Reusing the bootstrap keeps this consistent with bootstrapMeanCI
 * and free of a normal-approx assumption the skewed nDCG deltas would violate.
 */
export function pairedNonInferiority(
  deltas: number[],
  opts: { margin?: number; alpha?: number; resamples?: number; seed?: number } = {},
): NonInferiorityResult {
  const margin = opts.margin ?? -0.015;
  const alpha = opts.alpha ?? 0.05;
  const n = deltas.length;
  if (n === 0) return { mean: 0, margin, lowerBound: 0, nonInferior: 0 > margin, alpha };
  const resamples = opts.resamples ?? 10_000;
  const rng = mulberry32(opts.seed ?? 1337);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += deltas[Math.floor(rng() * n)] ?? 0;
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  // one-sided (1−α) lower bound = the α-quantile of the bootstrap mean distribution.
  const idx = Math.min(means.length - 1, Math.max(0, Math.floor(alpha * means.length)));
  const lowerBound = means[idx] ?? 0;
  return { mean: mean(deltas), margin, lowerBound, nonInferior: lowerBound > margin, alpha };
}

export function describeNonInferiority(deltas: number[], label: string, margin = -0.015): string {
  const r = pairedNonInferiority(deltas, { margin });
  return (
    `${label}: Δmean ${r.mean >= 0 ? "+" : ""}${r.mean.toFixed(3)}  ` +
    `one-sided 95% lower ${r.lowerBound >= 0 ? "+" : ""}${r.lowerBound.toFixed(3)}  ` +
    `vs floor ${margin}  → ${r.nonInferior ? "NON-INFERIOR" : "FAILS FLOOR"}`
  );
}

export interface BHResult {
  /** Index into the input array (input order is preserved in the returned rows). */
  index: number;
  p: number;
  /** BH critical value (rank/m)·q for this p's ascending rank. */
  critical: number;
  rejected: boolean;
}

/**
 * Benjamini-Hochberg FDR across a family of raw p-values (the config-sweep policy the
 * README previously said to apply "by hand", q=0.10). Rejects every hypothesis with
 * rank ≤ the largest k where p(k) ≤ (k/m)·q. Returns rows in INPUT order so callers
 * can line results up with their configs.
 */
export function benjaminiHochberg(pvalues: number[], q = 0.1): BHResult[] {
  const m = pvalues.length;
  if (m === 0) return [];
  const sorted = pvalues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
  // largest rank k (1-based) with p(k) ≤ (k/m)·q
  let maxK = 0;
  for (let i = 0; i < m; i++) {
    const entry = sorted[i];
    if (entry && entry.p <= ((i + 1) / m) * q) maxK = i + 1;
  }
  const rows: BHResult[] = new Array(m);
  for (let i = 0; i < m; i++) {
    const entry = sorted[i];
    if (!entry) continue;
    rows[entry.index] = {
      index: entry.index,
      p: entry.p,
      critical: ((i + 1) / m) * q,
      rejected: i + 1 <= maxK,
    };
  }
  return rows;
}
