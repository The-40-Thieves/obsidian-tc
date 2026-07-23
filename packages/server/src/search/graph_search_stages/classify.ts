// THE-465 "classify" stage: the seed-strength router decision. Moved verbatim out of
// graphSearchCore's step 2 — same z-margin math, same absolute-cosine fallback rule, same
// defaults (routerEnabled ?? true, routerSim ?? 0.62, routerMargin ?? 0.08).
import type { SemanticHit } from "../semantic";

/** THE-400: top-1 z-margin over a (descending) score pool — (top1 − μ)/σ, population σ. The
 *  model-agnostic dense-confidence signal: absolute cosine thresholds shift with the embedding
 *  model's dimension/anisotropy, but "how far top-1 sits above its own candidate distribution"
 *  transfers. 0 when the pool has fewer than 2 scores or zero variance (no signal). O(K) over
 *  scores already in memory — no extra calls. Exported for the eval's calibration table. */
export function seedZMargin(scores: number[]): number {
  if (scores.length < 2) return 0;
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const sd = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length);
  return sd > 0 ? ((scores[0] ?? 0) - mean) / sd : 0;
}

export interface ClassifyInput {
  seeds: SemanticHit[];
  routerEnabled: boolean;
  routerSim: number;
  routerMargin: number;
  zThreshold?: number;
}

export interface ClassifyResult {
  /** THE-400: top-1 z-margin over the seed-cosine pool — shared by the router's z-mode and the
   *  gated-rerank hardness gate downstream. */
  zMargin: number;
  /** Seed-strength router: true when expansion should be SKIPPED because the dense seeds are
   *  already confident. */
  routedToSeedsOnly: boolean;
}

/** Seed-strength router: skip expansion when the baseline is already confident. semanticSearch
 *  score IS cosine, so no recompute (cleaner than the KMS path). THE-400: the z-margin (top-1
 *  z-score over the seed pool) is the model-agnostic form of "confident dense lock" — shared by
 *  the router's z-mode and the gated-rerank hardness gate. */
export function classify(input: ClassifyInput): ClassifyResult {
  const { seeds, routerEnabled, routerSim, routerMargin, zThreshold } = input;
  const zMargin = seedZMargin(seeds.map((s) => s.score));
  let routedToSeedsOnly = false;
  if (routerEnabled) {
    if (zThreshold !== undefined) {
      routedToSeedsOnly = zMargin >= zThreshold;
    } else {
      const top1 = seeds[0]?.score ?? 0;
      const top4 = seeds[Math.min(3, seeds.length - 1)]?.score ?? top1;
      if (top1 >= routerSim && top1 - top4 >= routerMargin) routedToSeedsOnly = true;
    }
  }
  return { zMargin, routedToSeedsOnly };
}
