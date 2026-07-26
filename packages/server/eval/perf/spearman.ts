// THE-594: Spearman rank correlation, factored out of the unit suite so it can be shared between
// the (pure-math, non-timing) proof that the statistic has power and the (real-timing) harness
// check that runs it against the actual `calibrateIo()` probe.
//
// Carried over from PR #496 (branch mislam2/the-594-the-584s-calibrateio-scaling-test-is-flaky-on-
// macos-12x-the, commit a6c6c7c) rather than rewritten: that PR's fix was statistically sound (it
// replaced a strict two-point `>` between two noisy timing samples with a rank-correlation trend
// over ten) and is carefully calibrated -- see SPEARMAN_THRESHOLD's doc comment for the exact
// derivation. It still flaked on windows-latest after landing in the unit suite (THE-594's actual
// disposition: relocate the assertion into the perf harness, not re-tune it again), which is why
// the logic lives here rather than back in a test file.

/** Ranks of a series, 0-based, ties broken by average rank (the standard treatment) — irrelevant
 *  in practice here since wall-clock durations essentially never collide, but it keeps the
 *  formula correct if they ever do. */
export function rank(values: number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((p, q) => p.value - q.value);
  const rankByIndex = new Map<number, number>();
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]?.value === order[i]?.value) j++;
    const averageRank = (i + j) / 2;
    for (let k = i; k <= j; k++) {
      const entry = order[k];
      if (entry) rankByIndex.set(entry.index, averageRank);
    }
    i = j + 1;
  }
  return values.map((_, index) => rankByIndex.get(index) ?? 0);
}

/** Rank correlation between two equal-length series, -1..1. THE-594: used to test "duration
 *  tracks rounds" as a trend over several points rather than a strict `>` between two. */
export function spearmanRankCorrelation(a: number[], b: number[]): number {
  const ra = rank(a);
  const rb = rank(b);
  const pairs = ra.map((value, i) => ({ ra: value, rb: rb[i] ?? 0 }));
  const meanA = pairs.reduce((s, p) => s + p.ra, 0) / pairs.length;
  const meanB = pairs.reduce((s, p) => s + p.rb, 0) / pairs.length;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (const p of pairs) {
    const da = p.ra - meanA;
    const db = p.rb - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return 0;
  return cov / Math.sqrt(varA * varB);
}

/** Applies `spearmanRankCorrelation` to a measurement function sampled at `sizes` — factored out
 *  so the SAME statistic can be run against the real `calibrateIo` and against a synthetic stub
 *  in the calibration proof, rather than duplicating the computation. */
export function spearmanFor(measure: (rounds: number) => number, sizes: number[]): number {
  return spearmanRankCorrelation(sizes, sizes.map(measure));
}

/** THE-594: round-counts sampled for the scaling check, n = 10. Starts at 8 (not 2) so none of
 *  these sizes is as setup-dominated by calibrateIo's first-round directory/inode warm-up cost as
 *  the original 2-round arm was (see the failure analysis in git history for commit a6c6c7c). */
export const SPEARMAN_SIZES = [8, 12, 16, 24, 32, 48, 64, 96, 128, 192];

/** THE-594: calibrated threshold, not a guess.
 *
 *  Under the null hypothesis that a measurement's duration is UNCORRELATED with the requested size
 *  (it degenerated to a constant, the loop got optimized away, etc.), Spearman's rho over n =
 *  `SPEARMAN_SIZES.length` = 10 points has a known null distribution. 0.564 is the standard
 *  published one-tailed p<0.05 critical value for n=10 (n=12 would be ~0.497): at most 5% of
 *  permutations carrying no real size/duration relationship produce a rho this high by chance, so
 *  `rho > SPEARMAN_THRESHOLD` rejects a non-scaling measurement at least 95% of the time, by
 *  construction — not by hope. (An independent full-enumeration check of the exact n=10
 *  permutation distribution landed at 0.5515; the gap to the published 0.564 is the usual table
 *  convention of rounding UP to the next distinct order statistic so the true tail probability
 *  never exceeds the nominal 5%. 0.564 is used here as the more conservative of the two.)
 *  `test/perf-spearman.test.ts`'s "rejects a constant-duration stub" case demonstrates the
 *  rejection directly, on a single deterministic case, rather than asserting the calibration on
 *  faith. */
export const SPEARMAN_THRESHOLD = 0.564;
