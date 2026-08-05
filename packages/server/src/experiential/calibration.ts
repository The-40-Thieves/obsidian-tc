// THE-733 / THE-631 item 1 — the per-vault score calibration: writer, reader, and the PURE
// function that turns a live top score into a confidence a caller can act on.
//
// THE ONE RULE THIS MODULE EXISTS TO ENFORCE: an uncalibrated vault returns NO confidence, never a
// confidence computed from a global constant. THE-631 condemned that in advance —
//
//   "a confidence number computed from another vault's percentiles is worse than no confidence
//    number, because it looks authoritative"
//
// — and the only number otherwise reachable from the request path is DEFAULT_GAP_THRESHOLD, a
// module constant from an n=136 calibration on one vault. So `confidenceFor` returns a DISCRIMINATED
// result whose unavailable branch carries a reason. Absent and low are different claims and are
// reported differently, the same distinction `explain_answer` draws between "not stamped" and
// "rejected".
import type { Database } from "../db/types";

/** The nine numbers `scoreDistribution` produces, as persisted. */
export interface ScoreCalibration {
  vault_id: string;
  computed_at: number;
  n: number;
  min: number;
  p5: number;
  p10: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
  p95: number;
  engine_version: string;
  config_fingerprint: string | null;
}

/**
 * Fewest queries a distribution may be built from and still be reported as a percentile.
 *
 * Below this the percentile is an artifact of which handful of queries happened to be in the
 * calibration set, not a property of the vault. `scoreDistribution`'s own `at()` picks
 * `s[ceil(p/100 * len) - 1]`, so at n=5 every percentile from p5 to p25 is the SAME element —
 * reporting "p5" there would be a label on an arbitrary sample point. Refusing is the honest
 * answer, and it is why `not_enough_samples` is its own reason rather than folded into
 * `not_calibrated`: one means nobody ran it, the other means it ran and cannot support the claim.
 */
export const MIN_CALIBRATION_N = 30;

/** Why no confidence could be reported. Each is a DIFFERENT fact about the world. */
export type ConfidenceUnavailable =
  /** No calibration row for this vault. Nobody has ever run `gaps --calibrate` against it. */
  | "not_calibrated"
  /** A calibration exists but was measured over too few queries to support a percentile. */
  | "not_enough_samples"
  /** The search returned nothing, so there is no top score to place. */
  | "no_results";

export type RetrievalConfidence =
  | { available: false; reason: ConfidenceUnavailable }
  | {
      available: true;
      /** Where the live top score falls in the vault's calibrated distribution, 0-100. */
      percentile: number;
      /** Coarse band, for callers that should not branch on a number. */
      band: "low" | "moderate" | "high";
      calibrated_at: number;
      /** Queries the calibration was measured over — a percentile from n=31 is not one from n=250. */
      calibrated_n: number;
      /** TRUE when the calibration came from a different engine version. Flagged, NOT discarded:
       *  a slightly stale percentile is still far better grounded than a foreign vault's constant. */
      stale_calibration: boolean;
    };

/**
 * Place a live top score in a calibrated distribution.
 *
 * PURE — no DB, no clock. `calibration` is passed in, `now` is not needed, and the engine version
 * to compare against is a parameter, so this is testable against fixtures.
 *
 * The percentile is INTERPOLATED between the stored anchors rather than snapped to the nearest
 * one. Nine anchors snapped would report the same percentile for a wide range of scores and make
 * the signal look coarser than the underlying data; interpolating between two real measurements is
 * the weakest assumption that still uses them both.
 */
export function confidenceFor(
  topScore: number | undefined,
  calibration: ScoreCalibration | null,
  currentEngineVersion: string,
): RetrievalConfidence {
  if (calibration === null) return { available: false, reason: "not_calibrated" };
  if (calibration.n < MIN_CALIBRATION_N) {
    return { available: false, reason: "not_enough_samples" };
  }
  if (topScore === undefined) return { available: false, reason: "no_results" };

  // Anchors in ascending order. `min` is the 0th percentile by construction.
  const anchors: Array<[percentile: number, score: number]> = [
    [0, calibration.min],
    [5, calibration.p5],
    [10, calibration.p10],
    [25, calibration.p25],
    [50, calibration.median],
    [75, calibration.p75],
    [90, calibration.p90],
    [95, calibration.p95],
  ];

  let percentile: number;
  if (topScore <= (anchors[0] as [number, number])[1]) {
    percentile = 0;
  } else if (topScore >= (anchors[anchors.length - 1] as [number, number])[1]) {
    percentile = 95;
  } else {
    percentile = 95;
    for (let i = 1; i < anchors.length; i++) {
      const [pHi, sHi] = anchors[i] as [number, number];
      const [pLo, sLo] = anchors[i - 1] as [number, number];
      if (topScore <= sHi) {
        // Guard the degenerate span: two anchors can share a score on a flat distribution, and
        // dividing by that zero width would yield Infinity/NaN and poison the band below.
        const width = sHi - sLo;
        percentile = width > 0 ? pLo + ((topScore - sLo) / width) * (pHi - pLo) : pLo;
        break;
      }
    }
  }

  return {
    available: true,
    percentile: Math.round(percentile * 10) / 10,
    band: percentile < 10 ? "low" : percentile < 75 ? "moderate" : "high",
    calibrated_at: calibration.computed_at,
    calibrated_n: calibration.n,
    stale_calibration: calibration.engine_version !== currentEngineVersion,
  };
}

/** Append a calibration. Append-only: recalibration history is itself useful. */
export function persistCalibration(edb: Database, c: ScoreCalibration): void {
  edb
    .prepare(
      `INSERT INTO score_calibration
         (vault_id, computed_at, n, min, p5, p10, p25, median, p75, p90, p95,
          engine_version, config_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      c.vault_id,
      c.computed_at,
      c.n,
      c.min,
      c.p5,
      c.p10,
      c.p25,
      c.median,
      c.p75,
      c.p90,
      c.p95,
      c.engine_version,
      c.config_fingerprint,
    );
}

/** Latest calibration for a vault, or null when the vault has never been calibrated. */
export function readLatestCalibration(edb: Database, vaultId: string): ScoreCalibration | null {
  const row = edb
    .prepare(
      `SELECT vault_id, computed_at, n, min, p5, p10, p25, median, p75, p90, p95,
              engine_version, config_fingerprint
         FROM score_calibration WHERE vault_id = ? ORDER BY computed_at DESC LIMIT 1`,
    )
    .get(vaultId) as ScoreCalibration | undefined;
  return row ?? null;
}
