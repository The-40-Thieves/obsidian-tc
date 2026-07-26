// THE-584 item 4: the channel-agnostic "this host is not comparable" check.
//
// The calibration probes (contention.ts) answer "was some SPECIFIC resource contended" — CPU, and
// since THE-584, I/O. They are only ever as good as the list of channels someone thought to probe.
// The incident that motivated the I/O channel is the proof: the CPU probe reported
// `clean (median 15.39ms, cv 0.056)` against a 15.37ms reference while every I/O-shaped metric was
// 40-90% worse, because nothing was watching that dimension.
//
// This check needs no probe at all, and therefore cannot be blind to a channel nobody imagined.
// It reads the WORKLOAD:
//
//   If most warn-class metrics moved in the WORSE direction together, while every hard-class
//   metric is byte-identical, the code did not change. The host did.
//
// The hard-class half is what makes it sound rather than merely suggestive. Hard metrics are
// seed-deterministic counts and ratios — chunk counts, transaction counts, booleans — which by
// construction do not depend on wall-clock or machine speed. A genuine code change that slowed
// things down almost always moves at least one of them (it indexed differently, batched
// differently, wrote a different number of rows). A slower MACHINE moves none of them. So
// "everything slower, nothing counted differently" is close to a signature.
//
// Calibrated against the incident itself, not invented. From THE-584's recorded numbers, comparing
// two independent CI recordings against the committed baseline:
//
//   index.chunks_per_s        2901.6 -> ~1567   1.85x worse
//   embed.texts_per_s         1741.0 -> ~940    1.85x worse
//   freshness.ms                34.8 -> ~68.3   1.96x worse
//   runtime.eventloop_p99_ms    37.4 -> ~65     1.74x worse
//   http.cold_ms                14.3 -> ~22.2   1.56x worse
//   storage.txn_ms               0.52 -> ~0.85  1.63x worse
//   ...and NO hard metric changed - every count identical.
//
// Six comparable metrics, all 1.5x-2x worse, zero hard-class movement. The defaults below
// (1.25x, 60%) clear that by a wide margin while staying above ordinary run-to-run noise on the
// warn metrics, which the perf README documents as the reason those metrics are warn-class at all.
import type { Baseline, PerfReport } from "./report";

export interface UniformShiftOptions {
  /** How much worse a single metric must be to count as "moved". Default 1.25 (25% worse). */
  minFactor?: number;
  /** Fraction of comparable metrics that must have moved worse. Default 0.6. */
  minFraction?: number;
  /** Minimum comparable metrics before the check applies at all. Default 4 — below that, a
   *  "majority moved" claim is not meaningful and would fire on noise. */
  minComparable?: number;
}

export interface UniformShiftResult {
  suspect: boolean;
  /** Warn-class metrics that moved worse by at least `minFactor`. */
  movedWorse: string[];
  /** Warn-class metrics compared at all (present in both, directional, warn-class). */
  comparable: number;
  /** Hard-class metrics whose value differs from baseline AT ALL. Non-zero means the workload
   *  genuinely changed, so a uniform slowdown is attributable to the code and this check stands
   *  down — that is a job for the ordinary gate, not for a host-comparability heuristic. */
  hardChanged: string[];
  /** Median worse-factor across `movedWorse`, for the operator-facing message. */
  medianFactor: number;
  reason?: string;
}

/** How many times WORSE `actual` is than `baseline`, honouring direction. <= 1 means not worse.
 *  `exact` metrics have no worse-direction and are excluded by the caller. */
function worseFactor(actual: number, b: Baseline[string]): number {
  if (b.value <= 0 || actual <= 0) return 1;
  // higher-worse is a cost (ms, bytes, counts); lower-worse is a throughput.
  return b.direction === "higher-worse" ? actual / b.value : b.value / actual;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0
    ? ((s[mid - 1] as number) + (s[mid] as number)) / 2
    : (s[mid] as number);
}

/**
 * Detect a uniform workload-wide slowdown with no change in deterministic counts.
 *
 * Deliberately consults only warn-class DIRECTIONAL metrics. `exact` metrics have no worse
 * direction, and hard-class metrics are the control group — counting them as "moved" would destroy
 * the very signal the check depends on.
 */
export function detectUniformShift(
  report: PerfReport,
  baseline: Baseline,
  opts?: UniformShiftOptions,
): UniformShiftResult {
  const minFactor = opts?.minFactor ?? 1.25;
  const minFraction = opts?.minFraction ?? 0.6;
  const minComparable = opts?.minComparable ?? 4;

  const byKey = new Map(report.samples.map((s) => [s.key, s]));
  const movedWorse: string[] = [];
  const factors: number[] = [];
  const hardChanged: string[] = [];
  let comparable = 0;

  for (const [key, b] of Object.entries(baseline)) {
    const sample = byKey.get(key);
    if (sample === undefined) continue; // the ordinary gate reports a missing metric; not our job

    if (b.class === "hard") {
      if (sample.value !== b.value) hardChanged.push(key);
      continue;
    }
    if (b.direction === "exact") continue; // no worse-direction to measure
    comparable += 1;
    const f = worseFactor(sample.value, b);
    if (f >= minFactor) {
      movedWorse.push(key);
      factors.push(f);
    }
  }

  const med = median(factors);
  const fraction = comparable > 0 ? movedWorse.length / comparable : 0;
  const suspect =
    hardChanged.length === 0 && comparable >= minComparable && fraction >= minFraction;

  return {
    suspect,
    movedWorse,
    comparable,
    hardChanged,
    medianFactor: med,
    ...(suspect
      ? {
          reason:
            `${movedWorse.length}/${comparable} warn metrics are >=${minFactor}x worse ` +
            `(median ${med.toFixed(2)}x) while every hard-class count is unchanged — that is a ` +
            `slower HOST, not a slower build. Recording this baseline would ratchet ` +
            `${movedWorse.length} thresholds looser in one commit.`,
        }
      : {}),
  };
}
