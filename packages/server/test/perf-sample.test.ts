import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PerfReport } from "../eval/perf/report";
import { runIsolatedSamples } from "../eval/perf/sample";

/** Fake reports: same scenario, one hard-class count and one warn-class latency that varies
 *  slightly per "run" plus a distinct calibrationMs per run to drive contention detection. */
function fakeReport(_i: number, latency: number, calibrationMs: number): PerfReport {
  return {
    scenario: "small",
    calibrationMs,
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
});
