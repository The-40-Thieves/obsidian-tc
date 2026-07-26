import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PerfReport } from "../eval/perf/report";
import { runIsolatedSamples } from "../eval/perf/sample";

/** Fake reports: same scenario, one hard-class count and one warn-class latency that varies
 *  slightly per "run" plus a distinct calibration probe per run to drive contention detection.
 *  BOTH channels are supplied (THE-584): an omitted channel is an all-zero series, which the
 *  detector now treats as UNMEASURED rather than clean, so these fakes must look like real
 *  reports or every case here would fail for the wrong reason. */
function fakeReport(
  _i: number,
  latency: number,
  calibrationMs: number,
  calibrationIoMs = 40,
  ioScalingRho = 0.9,
): PerfReport {
  return {
    scenario: "small",
    calibrationMs,
    calibrationIoMs,
    ioScalingRho,
    samples: [
      { key: "index.chunk_count", value: 200, unit: "count", class: "hard", direction: "exact" },
      {
        key: "dispatch.overhead_p99_ms",
        value: latency,
        unit: "ms",
        class: "warn",
        direction: "higher-worse",
      },
    ],
  };
}

describe("runIsolatedSamples() orchestration (fake spawn, no real subprocess)", () => {
  it("spawns exactly n samples and aggregates them", () => {
    const latencies = [10, 12, 11, 40, 13];
    const calibrations = [20, 21, 19, 20, 22]; // tight -- quiet host
    let calls = 0;
    const result = runIsolatedSamples("small", {
      n: 5,
      spawn: (scenario, outPath) => {
        expect(scenario).toBe("small");
        writeFileSync(
          outPath,
          JSON.stringify(
            fakeReport(calls, latencies[calls] as number, calibrations[calls] as number),
          ),
        );
        calls += 1;
      },
    });

    expect(calls).toBe(5);
    expect(result.aggregate.n).toBe(5);
    const latency = result.aggregate.samples.find((s) => s.key === "dispatch.overhead_p99_ms");
    expect(latency?.raw).toEqual(latencies);
    expect(latency?.median).toBe(12);
    expect(result.contention.contended).toBe(false);
    expect(result.hardInstabilities).toEqual([]);
  });

  it("flags contention when calibration probes are noisy across samples", () => {
    const calibrations = [20, 60, 21, 58, 22]; // one process shared the CPU with something else
    let calls = 0;
    const result = runIsolatedSamples("small", {
      n: 5,
      spawn: (_scenario, outPath) => {
        writeFileSync(
          outPath,
          JSON.stringify(fakeReport(calls, 10, calibrations[calls] as number)),
        );
        calls += 1;
      },
    });
    expect(result.contention.contended).toBe(true);
  });

  it("surfaces a hard-class metric that disagrees across samples", () => {
    let calls = 0;
    const result = runIsolatedSamples("small", {
      n: 3,
      spawn: (_scenario, outPath) => {
        const report = fakeReport(calls, 10, 20);
        if (calls === 1) (report.samples[0] as { value: number }).value = 201; // corrupted run
        writeFileSync(outPath, JSON.stringify(report));
        calls += 1;
      },
    });
    expect(result.hardInstabilities).toEqual([{ key: "index.chunk_count", raw: [200, 201, 200] }]);
  });

  it("propagates a subprocess failure as a thrown error", () => {
    expect(() =>
      runIsolatedSamples("small", {
        n: 2,
        spawn: () => {
          throw new Error("boom");
        },
      }),
    ).toThrow("boom");
  });

  it("rejects n < 1", () => {
    expect(() => runIsolatedSamples("small", { n: 0 })).toThrow(/n must be/);
  });

  // THE-594: the calibrateIo() scaling calibration is gathered the same way as the CPU/IO
  // contention channels above -- one real-timing observation per subprocess, judged on the
  // MEDIAN. This is the wiring only (fake reports, no real timing): the statistic itself is
  // proven to have power in test/perf-spearman.test.ts, and the actual gate on this value lives
  // in run.ts's `main()`, not in sample.ts's aggregation.
  it("aggregates ioScalingRho across samples as raw + median, tolerating a missing field", () => {
    const rhos = [0.95, 0.6, 0.99]; // one below SPEARMAN_THRESHOLD (0.564 -- still counted as raw)
    let calls = 0;
    const result = runIsolatedSamples("small", {
      n: 3,
      spawn: (_scenario, outPath) => {
        writeFileSync(outPath, JSON.stringify(fakeReport(calls, 10, 20, 40, rhos[calls])));
        calls += 1;
      },
    });
    expect(result.ioScalingRho.raw).toEqual(rhos);
    expect(result.ioScalingRho.median).toBe(0.95);
  });

  it("treats a report with no ioScalingRho field as 0, never as a crash", () => {
    const result = runIsolatedSamples("small", {
      n: 2,
      spawn: (_scenario, outPath) => {
        const report = fakeReport(0, 10, 20);
        delete (report as { ioScalingRho?: number }).ioScalingRho;
        writeFileSync(outPath, JSON.stringify(report));
      },
    });
    expect(result.ioScalingRho.raw).toEqual([0, 0]);
    expect(result.ioScalingRho.median).toBe(0);
  });
});
