import { closeSync, fsyncSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { SPEARMAN_SIZES, spearmanFor } from "./spearman";

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

// THE-584: the CPU loop above is only ONE contention channel, and the harness treated it as the
// whole answer. Two independent CI recordings came back 40-90% worse than the committed baseline
// on every warn metric while the detector printed `contention: clean (median 15.39ms, cv 0.056)`
// against a 15.37ms reference — CPU was genuinely unaffected. What was slow was I/O, and the
// metrics that moved were exactly the I/O-shaped ones (SQLite writes, freshness, HTTP handshake).
//
// So a second probe, measured here rather than assumed (16 rounds x 32 KiB, this host):
//
//   quiet                          median  43.2ms   cv 0.123   max/med 1.26
//   under 3 concurrent fsync writers  median 498.0ms   cv 0.105   max/med 1.23
//
// Two things that decided the design:
//
//  1. `fsync` is load-bearing. Without it the loop writes into page cache and measures a memcpy —
//     it would stay flat under exactly the disk contention it exists to detect.
//  2. The RELATIVE checks are blind here for the same reason they are blind to sustained CPU load:
//     under 11.5x slowdown the CV was 0.105, LOWER than the quiet host's 0.123. Only the absolute
//     reference check separates those two columns. That is why an I/O reference entry matters.
//
// I/O also needs its OWN thresholds. A quiet host reached cv 0.229 and max/med 1.46 across probe
// sizes — under the CPU thresholds (0.20 / 1.6) that is a false alarm on an idle machine, and a
// detector that cries wolf gets ignored, which is the failure this ticket was filed to prevent.

/** Fixed I/O work: rewrite a small file and fsync it, N times. Sized (like the CPU loop) to be
 *  well above timer noise but cheap enough to run once per isolated sample — ~43ms on a quiet
 *  reference host, so 5 samples add ~0.2s to a run. */
const IO_CALIBRATION_ROUNDS = 16;
const IO_CALIBRATION_BYTES = 32 * 1024;

export function calibrateIo(rounds = IO_CALIBRATION_ROUNDS, bytes = IO_CALIBRATION_BYTES): number {
  const dir = mkdtempSync(join(tmpdir(), "obtc-perf-iocal-"));
  try {
    const file = join(dir, "calibration.bin");
    // Allocated INSIDE the try: a bad `bytes` (negative, or larger than the max buffer length)
    // throws here, and outside the try that would leave the temp directory behind on every call.
    const buf = Buffer.alloc(bytes, 0xa5);
    const t0 = performance.now();
    for (let i = 0; i < rounds; i++) {
      const fd = openSync(file, "w");
      try {
        writeSync(fd, buf);
        // The whole point: force the data to the device. A buffered write would measure page-cache
        // memcpy and read as "fast" on a host whose disk is saturated.
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    return performance.now() - t0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// THE-594: the I/O channel's own scaling calibration used to be a unit test — a strict two-point
// `calibrateIo(24, ...) > calibrateIo(2, ...)` compare, then (after it flaked on macOS) a ten-point
// Spearman rank correlation between round-count and duration. That version STILL flaked, on
// windows-latest this time (perf-contention-io.test.ts:131, 13237ms) — a wall-clock assertion in
// the unit suite has to hold on three OSes, on shared runners, under arbitrary concurrency, with no
// isolation, and this one could not. Wrong venue, not wrong statistic: `measureIoScalingRho` moves
// the SAME calibration (spearman.ts's carried-over logic) into the perf harness, where isolate.ts
// already runs N genuinely fresh subprocess samples and gates on the median rather than a single
// noisy observation (see run.ts's `main()`).
export function measureIoScalingRho(): number {
  const first = SPEARMAN_SIZES[0] as number;
  calibrateIo(first, IO_CALIBRATION_BYTES); // warm-up: JIT + syscall paths, before any measurement
  return spearmanFor((rounds) => calibrateIo(rounds, IO_CALIBRATION_BYTES), SPEARMAN_SIZES);
}

/** One calibration observation per channel. Recorded per isolated sample by run.ts. */
export interface CalibrationVector {
  cpuMs: number;
  ioMs: number;
}

/** The channels a recording is judged on. Adding one here is the only way to add a dimension, and
 *  every consumer (reference file, detector, provenance sidecar) iterates this rather than naming
 *  channels individually — so a new channel cannot be silently skipped by one of them. */
export const CALIBRATION_CHANNELS = ["cpuMs", "ioMs"] as const;
export type CalibrationChannel = (typeof CALIBRATION_CHANNELS)[number];

/** Per-channel defaults. CPU keeps THE-503's original numbers exactly; I/O is looser because a
 *  QUIET host already measures cv 0.229 / max-med 1.46 (see the module note) and reusing the CPU
 *  thresholds would refuse clean recordings. The reference tolerance is 1.0 (100% slower) rather
 *  than CPU's 0.5 for the same reason — and the observed contention signal is 11.5x, so the looser
 *  bound costs nothing in detection power. */
export const CHANNEL_DEFAULTS: Record<
  CalibrationChannel,
  Required<Omit<ContentionOptions, "referenceMs">>
> = {
  cpuMs: { cvThreshold: 0.2, maxOverMedianThreshold: 1.6, referenceTol: 0.5 },
  ioMs: { cvThreshold: 0.45, maxOverMedianThreshold: 2.5, referenceTol: 1.0 },
};

/** Human label for a channel, used in operator-facing output. */
export const CHANNEL_LABEL: Record<CalibrationChannel, string> = {
  cpuMs: "cpu",
  ioMs: "io",
};

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

/** A committed quiet-host median per channel. Channels are optional individually: a reference
 *  recorded before THE-584 has only `cpuMs`, and that must keep working (relative checks still run
 *  on both channels; the absolute check simply does not apply to the missing one). */
export type CalibrationReferenceVector = Partial<Record<CalibrationChannel, number>>;

/** Per-channel THRESHOLD overrides. `referenceMs` is deliberately excluded: it is the committed
 *  measurement, not a knob, and allowing it here would let a caller delete the absolute check by
 *  passing `undefined` for it. Tests that want a different reference pass one via `reference`. */
export type ContentionThresholds = Omit<ContentionOptions, "referenceMs">;
export type ChannelThresholdOverrides = Partial<Record<CalibrationChannel, ContentionThresholds>>;

/** Drop undefined-valued keys so a partially-filled override object cannot blank out a default. */
function definedOnly(o: ContentionThresholds | undefined): ContentionThresholds {
  if (!o) return {};
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as ContentionThresholds;
}

export interface VectorContentionResult {
  contended: boolean;
  /** Per-channel verdicts, always present for every channel in CALIBRATION_CHANNELS. */
  channels: Record<CalibrationChannel, ContentionResult>;
  /** Names the FAILING channel(s), so a reviewer can see which dimension was dirty rather than
   *  only that something was — the scalar output could not distinguish CPU from I/O at all. */
  reason?: string;
}

/**
 * THE-584: run the full check over every calibration channel and fail if ANY is contended.
 *
 * Deliberately a fan-out over the existing scalar `detectContention` rather than a reimplementation:
 * the three checks (CV, max/median, absolute-vs-reference) ask the same question of each channel,
 * and duplicating them would let the channels' semantics drift apart.
 */
export function detectContentionVector(
  samples: CalibrationVector[],
  reference?: CalibrationReferenceVector,
  overrides?: ChannelThresholdOverrides,
): VectorContentionResult {
  const channels = {} as Record<CalibrationChannel, ContentionResult>;
  const reasons: string[] = [];
  for (const channel of CALIBRATION_CHANNELS) {
    const series = samples.map((s) => s[channel]);
    // An all-zero series means the probe never ran (an old subprocess, a collector that threw, a
    // field renamed) — and every relative check trivially PASSES on it: cv 0, max/median 1. It
    // would read as the quietest host imaginable. Unmeasured must never be reported as clean; that
    // is the same measures-nothing-while-green failure this whole detector exists to prevent.
    if (series.length === 0 || series.every((v) => v === 0)) {
      channels[channel] = {
        contended: true,
        median: 0,
        cv: 0,
        raw: series,
        reason:
          "calibration probe reported nothing (all-zero series) — the channel was not measured",
      };
      reasons.push(`${CHANNEL_LABEL[channel]}: unmeasured`);
      continue;
    }
    const result = detectContention(series, {
      ...CHANNEL_DEFAULTS[channel],
      // Only DEFINED override values win. A plain spread would let `{cvThreshold: undefined}` — the
      // natural result of building an override object from optional fields — overwrite the channel
      // default with undefined, at which point detectContention falls back to its own CPU-shaped
      // defaults and the I/O channel is silently judged by the wrong thresholds.
      ...definedOnly(overrides?.[channel]),
      // Reference LAST and never overridable: `referenceMs` is not a threshold, it is the committed
      // measurement, and an override carrying `referenceMs: undefined` would silently delete the
      // absolute check — the exact "a check that quietly stops running" failure this ticket exists
      // to fix. The type forbids it too (ChannelThresholdOverrides omits it); this is belt and braces.
      ...(reference?.[channel] !== undefined ? { referenceMs: reference[channel] } : {}),
    });
    channels[channel] = result;
    if (result.contended)
      reasons.push(`${CHANNEL_LABEL[channel]}: ${result.reason ?? "contended"}`);
  }
  return {
    contended: reasons.length > 0,
    channels,
    ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}),
  };
}

/** Compact operator-facing summary of EVERY channel — the "calibration vector, not a scalar" the
 *  ticket asked for, so a reviewer can see which dimension was clean instead of trusting one number. */
export function formatCalibrationVector(result: VectorContentionResult): string {
  return CALIBRATION_CHANNELS.map((c) => {
    const r = result.channels[c];
    return `${CHANNEL_LABEL[c]} ${r.median.toFixed(2)}ms cv ${r.cv.toFixed(3)}${r.contended ? " DIRTY" : ""}`;
  }).join(", ");
}
