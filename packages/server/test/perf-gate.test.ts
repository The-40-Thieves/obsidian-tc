import { describe, expect, it } from "vitest";
import { evaluate } from "../eval/perf/gate";
import type { Baseline, PerfReport } from "../eval/perf/report";

const baseline: Baseline = {
  "index.chunks_per_s": {
    value: 4000,
    tol: 0.15,
    mode: "ratio",
    class: "hard",
    direction: "lower-worse",
  },
  "embed.dup_ratio": {
    value: 0.5,
    tol: 0.01,
    mode: "abs",
    class: "hard",
    direction: "higher-worse",
  },
  "dispatch.p95_ms": {
    value: 10,
    tol: 0.4,
    mode: "ratio",
    class: "warn",
    direction: "higher-worse",
  },
};

function report(samples: PerfReport["samples"]): PerfReport {
  return { scenario: "small", samples };
}

describe("perf gate evaluate()", () => {
  it("passes when all metrics are within tolerance", () => {
    const r = evaluate(
      report([
        {
          key: "index.chunks_per_s",
          value: 3800,
          unit: "per_s",
          class: "hard",
          direction: "lower-worse",
        },
        {
          key: "embed.dup_ratio",
          value: 0.505,
          unit: "ratio",
          class: "hard",
          direction: "higher-worse",
        },
        { key: "dispatch.p95_ms", value: 12, unit: "ms", class: "warn", direction: "higher-worse" },
      ]),
      baseline,
    );
    expect(r.hardFailures).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
  });

  it("hard-fails a lower-worse throughput regression past ratio tol", () => {
    const r = evaluate(
      report([
        {
          key: "index.chunks_per_s",
          value: 3000,
          unit: "per_s",
          class: "hard",
          direction: "lower-worse",
        },
      ]),
      baseline,
    );
    expect(r.hardFailures.map((v) => v.key)).toEqual(["index.chunks_per_s"]);
  });

  it("does not fail when a metric IMPROVES (throughput higher)", () => {
    const r = evaluate(
      report([
        {
          key: "index.chunks_per_s",
          value: 9000,
          unit: "per_s",
          class: "hard",
          direction: "lower-worse",
        },
      ]),
      baseline,
    );
    expect(r.hardFailures).toHaveLength(0);
  });

  it("hard-fails a higher-worse abs regression (dup ratio drifted up)", () => {
    const r = evaluate(
      report([
        {
          key: "embed.dup_ratio",
          value: 0.52,
          unit: "ratio",
          class: "hard",
          direction: "higher-worse",
        },
      ]),
      baseline,
    );
    expect(r.hardFailures.map((v) => v.key)).toEqual(["embed.dup_ratio"]);
  });

  it("routes warn-class violations to warnings, never hardFailures", () => {
    const r = evaluate(
      report([
        {
          key: "dispatch.p95_ms",
          value: 100,
          unit: "ms",
          class: "warn",
          direction: "higher-worse",
        },
      ]),
      baseline,
    );
    expect(r.hardFailures).toHaveLength(0);
    expect(r.warnings.map((v) => v.key)).toEqual(["dispatch.p95_ms"]);
  });
});
