import { describe, expect, it } from "vitest";
import { aggregate, checkHardStability, toMedianReport } from "../eval/perf/isolate";
import type { PerfReport } from "../eval/perf/report";

function report(scenario: string, values: Record<string, number>): PerfReport {
  return {
    scenario,
    samples: Object.entries(values).map(([key, value]) => ({
      key,
      value,
      unit: "ms" as const,
      class: key.startsWith("hard") ? ("hard" as const) : ("warn" as const),
      direction: "higher-worse" as const,
    })),
  };
}

describe("perf isolate: aggregate()", () => {
  it("throws on an empty report list", () => {
    expect(() => aggregate([])).toThrow();
  });

  it("computes median + cv + preserves raw samples per key across N reports", () => {
    const reports = [
      report("small", { "warn.latency_ms": 10, "hard.count": 5 }),
      report("small", { "warn.latency_ms": 12, "hard.count": 5 }),
      report("small", { "warn.latency_ms": 11, "hard.count": 5 }),
      report("small", { "warn.latency_ms": 40, "hard.count": 5 }),
      report("small", { "warn.latency_ms": 13, "hard.count": 5 }),
    ];
    const agg = aggregate(reports);
    expect(agg.scenario).toBe("small");
    expect(agg.n).toBe(5);

    const latency = agg.samples.find((s) => s.key === "warn.latency_ms");
    expect(latency?.raw).toEqual([10, 12, 11, 40, 13]);
    expect(latency?.median).toBe(12);
    expect(latency?.cv).toBeGreaterThan(0);

    const count = agg.samples.find((s) => s.key === "hard.count");
    expect(count?.raw).toEqual([5, 5, 5, 5, 5]);
    expect(count?.median).toBe(5);
    expect(count?.cv).toBe(0);
  });

  it("rejects reports from different scenarios", () => {
    const reports = [report("small", { x: 1 }), report("medium", { x: 1 })];
    expect(() => aggregate(reports)).toThrow(/scenario mismatch/);
  });

  it("rejects a metric whose unit/class/direction changes across samples", () => {
    const a = report("small", { "hard.count": 1 });
    const b: PerfReport = {
      scenario: "small",
      samples: [{ key: "hard.count", value: 1, unit: "ms", class: "warn", direction: "exact" }],
    };
    expect(() => aggregate([a, b])).toThrow(/shape changed/);
  });
});

describe("perf isolate: toMedianReport()", () => {
  it("projects the aggregate down to a PerfReport keyed on the median", () => {
    const agg = aggregate([
      report("small", { "warn.latency_ms": 10 }),
      report("small", { "warn.latency_ms": 20 }),
      report("small", { "warn.latency_ms": 30 }),
    ]);
    const projected = toMedianReport(agg);
    expect(projected.scenario).toBe("small");
    expect(projected.samples).toEqual([
      { key: "warn.latency_ms", value: 20, unit: "ms", class: "warn", direction: "higher-worse" },
    ]);
  });
});

describe("perf isolate: checkHardStability()", () => {
  it("is clean when every hard-class metric agrees across samples", () => {
    const agg = aggregate([
      report("small", { "hard.count": 5, "warn.latency_ms": 1 }),
      report("small", { "hard.count": 5, "warn.latency_ms": 2 }),
    ]);
    expect(checkHardStability(agg)).toEqual([]);
  });

  it("flags a hard-class metric that varies across isolated samples", () => {
    const agg = aggregate([
      report("small", { "hard.count": 5 }),
      report("small", { "hard.count": 6 }), // should never happen for a seeded deterministic run
    ]);
    const instabilities = checkHardStability(agg);
    expect(instabilities).toHaveLength(1);
    expect(instabilities[0]).toEqual({ key: "hard.count", raw: [5, 6] });
  });

  it("never flags warn-class metrics, however noisy", () => {
    const agg = aggregate([
      report("small", { "warn.latency_ms": 1 }),
      report("small", { "warn.latency_ms": 1000 }),
    ]);
    expect(checkHardStability(agg)).toEqual([]);
  });
});
