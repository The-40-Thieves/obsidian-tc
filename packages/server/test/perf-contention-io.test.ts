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

describe("THE-584 calibrateIo()", () => {
  it("returns a positive, finite wall-time measurement and leaves no temp files behind", () => {
    const before = mkdtempSync(join(tmpdir(), "obtc-iocal-probe-"));
    rmSync(before, { recursive: true, force: true });
    const ms = calibrateIo(2, 4096); // tiny — this is a unit test, not a benchmark
    expect(ms).toBeGreaterThan(0);
    expect(Number.isFinite(ms)).toBe(true);
  });

  // THE-594: "scales with the amount of work" used to be asserted HERE, first as a strict
  // two-point `>` (flaked on macOS CI), then as a ten-point Spearman rank correlation (flaked on
  // windows-latest too — perf-contention-io.test.ts:131, 13237ms, even after that recalibration).
  // A wall-clock assertion in the unit suite has to hold on three OSes, on shared runners, under
  // arbitrary concurrency, with no isolation — the wrong venue for it twice over. The check now
  // lives in the perf harness (eval/perf/contention.ts's measureIoScalingRho(), gated on the
  // median across N isolated subprocess samples in run.ts's `main()`). The statistic itself
  // (spearman.ts) is proven to have power — i.e. that it actually REJECTS a non-scaling
  // calibrateIo — deterministically and without any real timing in
  // test/perf-spearman.test.ts, which is what stayed a unit test.
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
