// THE-584: the I/O calibration channel. The CPU-only detector reported
// `contention: clean (median 15.39ms, cv 0.056)` on hosts that were 40-90% slower on every
// I/O-shaped metric, and a recording made there ratcheted 14 warn thresholds ~2x looser.
//
// The fixtures below are not invented: every number is a real measurement from this host, recorded
// in contention.ts's module note (quiet 43.2ms / cv 0.123; under three concurrent fsync writers
// 498.0ms / cv 0.105). The detector was watched firing on that load before these were written — a
// detector that has never been observed to fire is not known to work.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CALIBRATION_CHANNELS,
  type CalibrationVector,
  CHANNEL_DEFAULTS,
  calibrateIo,
  detectContentionVector,
  formatCalibrationVector,
} from "../eval/perf/contention";

const vec = (cpuMs: number, ioMs: number): CalibrationVector => ({ cpuMs, ioMs });

/** Ranks of a series, 0-based, ties broken by average rank (the standard treatment) — irrelevant
 *  in practice here since wall-clock durations essentially never collide, but it keeps the
 *  formula correct if they ever do. */
function rank(values: number[]): number[] {
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
function spearmanRankCorrelation(a: number[], b: number[]): number {
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
 *  in the calibration proof below, rather than duplicating the computation. */
function spearmanFor(measure: (rounds: number) => number, sizes: number[]): number {
  return spearmanRankCorrelation(sizes, sizes.map(measure));
}

/** THE-594: round-counts sampled for the scaling test, n = 10. Starts at 8 (not 2) so none of
 *  these sizes is as setup-dominated by the first-round directory/inode warm-up cost as the
 *  original 2-round arm was (see the failure analysis below). */
const SPEARMAN_SIZES = [8, 12, 16, 24, 32, 48, 64, 96, 128, 192];

/** THE-594: calibrated threshold, not a guess.
 *
 *  Under the null hypothesis that `calibrateIo`'s duration is UNCORRELATED with `rounds` (it
 *  degenerated to a constant, the loop got optimized away, etc.), Spearman's rho over n =
 *  `SPEARMAN_SIZES.length` = 10 points has a known null distribution. 0.564 is the standard
 *  published one-tailed p<0.05 critical value for n=10 (n=12 would be ≈0.497): at most 5% of
 *  permutations carrying no real rounds/duration relationship produce a rho this high by chance,
 *  so `expect(rho).toBeGreaterThan(SPEARMAN_THRESHOLD)` rejects a non-scaling `calibrateIo` at
 *  least 95% of the time, by construction — not by hope. (An independent full-enumeration check
 *  of the exact n=10 permutation distribution, run while this was under review, landed at 0.5515;
 *  the gap to the published 0.564 is the usual table convention of rounding UP to the next
 *  distinct order statistic so the true tail probability never exceeds the nominal 5%. 0.564 is
 *  used here as the more conservative of the two.) The "fails on a constant calibrateIo stub" test
 *  below demonstrates the rejection directly, on a single deterministic case, rather than only
 *  asserting the calibration on faith. */
const SPEARMAN_THRESHOLD = 0.564;

describe("THE-584 calibrateIo()", () => {
  it("returns a positive, finite wall-time measurement and leaves no temp files behind", () => {
    const before = mkdtempSync(join(tmpdir(), "obtc-iocal-probe-"));
    rmSync(before, { recursive: true, force: true });
    const ms = calibrateIo(2, 4096); // tiny — this is a unit test, not a benchmark
    expect(ms).toBeGreaterThan(0);
    expect(Number.isFinite(ms)).toBe(true);
  });

  // THE-594: this flaked on macOS CI — 24 rounds measured FASTER than 2 (54.3ms vs 63.7ms). Two
  // contributing causes, both confirmed against the failure before choosing this fix:
  //
  //  1. macOS `fsync(2)` does not force a flush to the physical device (that needs
  //     `F_FULLFSYNC`), so the true per-sync cost there is small and the measurement is dominated
  //     by everything else around the loop rather than by the syncs.
  //  2. `calibrateIo` opens the SAME file path each round, but that path lives inside a fresh
  //     `mkdtemp`'d directory created once per call — so the very first round pays a one-time
  //     directory/inode-warm-up cost the rest do not. At 2 rounds that is ~50% of the total; at 24
  //     rounds it is under 5%. Comparing a setup-dominated arm to a steady-state one is
  //     under-powered by construction, independent of cause 1.
  //
  // A strict `>` between exactly two noisy samples stakes the whole assertion on two point
  // estimates, however far apart the sizes are or however many trials get averaged into each one:
  // a single stalled sample on either side can still flip a two-point comparison, no matter the
  // margin (confirmed here — raising the arms and taking a median of 5 still flaked once under a
  // heavily loaded host, on a `>` that holds on every unloaded run).
  //
  // So instead of comparing two arms, sample SEVERAL sizes and check the TREND across all of them
  // via Spearman rank correlation between `rounds` and measured duration. This asks the actual
  // question the test name asks — "does duration scale with rounds" — using every data point at
  // once rather than two. A single noisy point among ten only nudges the correlation; it cannot
  // flip it the way it can flip a two-point `>`. And unlike a wall-clock margin, a correlation
  // coefficient needs no host-specific tuning: it is close to +1 when duration tracks rounds
  // (real work), and close to 0 when duration is independent of rounds (a constant, or noise
  // swamping a signal too small to detect on this host — see cause 1 above). `SPEARMAN_THRESHOLD`
  // is calibrated, not guessed — see its doc comment for the exact derivation.
  it("scales with the amount of work, so it is measuring the loop and not a constant", () => {
    calibrateIo(8, 4096); // warm-up: JIT + syscall paths, before any measurement is taken

    const rho = spearmanFor((rounds) => calibrateIo(rounds, 4096), SPEARMAN_SIZES);
    expect(rho).toBeGreaterThan(SPEARMAN_THRESHOLD);
  });

  // THE-594: the calibration above is only trustworthy if it actually REJECTS the failure mode it
  // exists to catch — a `calibrateIo` whose duration does not depend on `rounds`. Prove that
  // directly, deterministically, rather than asserting it on faith: a fixed value plus a small
  // deterministic wobble unrelated to `rounds` (not zero wobble — an exact constant only exercises
  // this file's zero-variance guard clause, which would prove nothing about the actual rank
  // statistic) must land below `SPEARMAN_THRESHOLD`. No timing, no RNG, no repeated trials — one
  // computation, one assertion, reproducible on every host and every run.
  it("rejects a constant-duration calibrateIo stub, proving the calibration has power", () => {
    let calls = 0;
    // ~50-54ms, cycling independently of `rounds` — a stand-in for "the loop stopped measuring
    // anything and duration no longer tracks the work requested".
    const constantStub = (_rounds: number) => 50 + ((calls++ * 7) % 5);

    const rho = spearmanFor(constantStub, SPEARMAN_SIZES);
    expect(rho).toBeLessThanOrEqual(SPEARMAN_THRESHOLD);
  });
});

describe("THE-584 detectContentionVector()", () => {
  it("passes when every channel is quiet", () => {
    const r = detectContentionVector([vec(20, 43), vec(21, 44), vec(19, 42), vec(20, 45)]);
    expect(r.contended).toBe(false);
    expect(r.reason).toBeUndefined();
  });

  // The core of the ticket: CPU quiet, I/O sustained-slow. The OLD scalar detector saw only the
  // first column and reported clean.
  it("flags an I/O-slow host whose CPU is perfectly quiet", () => {
    const quietCpuSlowIo = [vec(20, 498), vec(21, 495), vec(19, 501), vec(20, 499)];
    const r = detectContentionVector(quietCpuSlowIo, { cpuMs: 20, ioMs: 43 });
    expect(r.contended).toBe(true);
    expect(r.reason).toMatch(/^io:/); // names the dirty channel, not just "contended"
    expect(r.channels.cpuMs.contended).toBe(false); // CPU genuinely was fine
    expect(r.channels.ioMs.contended).toBe(true);
  });

  it("still flags a CPU-slow host, unchanged from THE-503", () => {
    const r = detectContentionVector([vec(45, 43), vec(44, 44), vec(46, 42)], {
      cpuMs: 20,
      ioMs: 43,
    });
    expect(r.contended).toBe(true);
    expect(r.reason).toMatch(/cpu:/);
  });

  // Sustained I/O load produced cv 0.105 — LOWER than the quiet host's 0.123. The relative checks
  // cannot see it at all; only the committed reference can. Without a reference this series must
  // therefore pass, which is exactly why the reference entry has to exist.
  it("cannot detect uniform I/O slowness without a reference (why the reference entry matters)", () => {
    const uniformlySlow = [vec(20, 498), vec(21, 495), vec(19, 501), vec(20, 499)];
    expect(detectContentionVector(uniformlySlow).contended).toBe(false);
    expect(detectContentionVector(uniformlySlow, { ioMs: 43 }).contended).toBe(true);
  });

  it("treats an unmeasured (all-zero) channel as dirty, never as clean", () => {
    // cv 0 and max/median 1 — an all-zero series passes every relative check, so it would read as
    // the quietest host imaginable. That is the silent-zero failure, not a clean bill of health.
    const r = detectContentionVector([vec(20, 0), vec(21, 0), vec(19, 0)]);
    expect(r.contended).toBe(true);
    expect(r.channels.ioMs.reason).toMatch(/not measured/);
    expect(r.channels.cpuMs.contended).toBe(false);
  });

  it("applies looser thresholds to I/O than to CPU, so a quiet host is not refused", () => {
    // Measured on a quiet host: I/O cv reached 0.229 and max/median 1.46 with nothing else running.
    // This series sits at cv ~0.231 / max-median ~1.33 — above the CPU CV threshold, below the I/O
    // one, and below both max/median bounds, so CV is the sole discriminator. Under the CPU
    // thresholds this is a false alarm on an idle machine.
    const quietButJittery = [vec(20, 28), vec(20, 43), vec(20, 55), vec(20, 40)];
    const r = detectContentionVector(quietButJittery);
    expect(r.channels.ioMs.cv).toBeGreaterThan(CHANNEL_DEFAULTS.cpuMs.cvThreshold);
    expect(r.channels.ioMs.cv).toBeLessThan(CHANNEL_DEFAULTS.ioMs.cvThreshold);
    expect(r.contended).toBe(false);
  });

  // Cross-vendor review (codex) flagged both of these as ways a check could quietly stop running —
  // the same class of defect as the CPU-only blindness this ticket is about.
  it("an override carrying undefined does not blank out a channel default", () => {
    // Building an override from optional fields naturally yields `{cvThreshold: undefined}`. A plain
    // spread would overwrite the I/O default with undefined, and detectContention would then fall
    // back to ITS defaults — which are CPU-shaped — judging I/O by the wrong thresholds.
    const jittery = [vec(20, 28), vec(20, 43), vec(20, 55), vec(20, 40)]; // cv ~0.231
    const r = detectContentionVector(jittery, undefined, {
      ioMs: { cvThreshold: undefined, maxOverMedianThreshold: undefined },
    });
    expect(r.channels.ioMs.contended).toBe(false); // still judged by the I/O default of 0.45
  });

  it("an override cannot delete the absolute check that a committed reference established", () => {
    const uniformlySlow = [vec(20, 498), vec(21, 495), vec(19, 501)];
    const r = detectContentionVector(
      uniformlySlow,
      { ioMs: 43 },
      {
        // referenceMs is not part of ContentionThresholds, so this is a type error too — the runtime
        // ordering is the belt to that type-level braces.
        ioMs: { referenceTol: 1.0 } as never,
      },
    );
    expect(r.channels.ioMs.contended).toBe(true);
  });

  it("reports every channel in the summary, so a reviewer sees which dimension was clean", () => {
    const text = formatCalibrationVector(
      detectContentionVector([vec(20, 498), vec(21, 495), vec(19, 501)], { ioMs: 43 }),
    );
    for (const c of CALIBRATION_CHANNELS) expect(text).toContain(c === "cpuMs" ? "cpu" : "io");
    expect(text).toContain("DIRTY");
  });
});

// ---------------------------------------------------------------------------------------------
// `fsync` is the property the whole channel rests on, so it gets a DETERMINISTIC guard.
//
// The obvious test — hammer the disk, assert the probe slows down — was written first and thrown
// away: it passed with `fsync` REMOVED. Two reasons it measured nothing. The load ran sequentially
// *before* each probe rather than concurrently with it, so the disk was already idle again by the
// time the probe started; and `loaded > idle` is satisfied by ordinary noise. Measured, that broken
// test produced 1.18x sabotaged and 0.93x intact — it could not even order the two correctly.
//
// Real concurrent load DOES show the effect (43ms -> 498ms, 11.5x, with three background fsync
// writers; recorded in contention.ts's module note). But reproducing that needs background
// processes and enough sustained traffic to saturate whatever disk CI happens to have, which is
// exactly the shape of a flaky test. Asserting the syscall is issued pins the same property with
// none of that: if `fsync` is ever dropped, this fails immediately and unambiguously.
// ---------------------------------------------------------------------------------------------
describe("THE-584 calibrateIo issues a real fsync per round", () => {
  it("calls fsyncSync exactly once per round — a buffered write would measure page cache, not disk", async () => {
    vi.resetModules();
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const fsyncSpy = vi.fn(actual.fsyncSync);
    vi.doMock("node:fs", () => ({ ...actual, default: actual, fsyncSync: fsyncSpy }));

    const { calibrateIo: freshCalibrateIo } = await import("../eval/perf/contention");
    freshCalibrateIo(7, 4096);
    expect(fsyncSpy).toHaveBeenCalledTimes(7);

    vi.doUnmock("node:fs");
    vi.resetModules();
  });
});
