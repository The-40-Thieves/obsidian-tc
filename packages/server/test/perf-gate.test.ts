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

// THE-503: transaction-count regression test. This is the exact shape writeBaseline() emits for
// index.txn_count (see run.ts + collectors/indexing.ts): class hard, mode ratio, direction
// "higher-worse" (a transaction count is a COST metric, like storage.bytes — MORE is the
// regression direction, FEWER is strictly an improvement). Getting this direction backwards (as
// an earlier draft of this fix did) would silently re-create the exact bug THE-503 asks to fix:
// a legitimate batching win failing to register, or worse, a real regression failing to gate.
describe("perf gate: index.txn_count (THE-503 lower-is-better, not exact-match)", () => {
  const txnBaseline: Baseline = {
    "index.txn_count": {
      value: 3,
      tol: 0.15,
      mode: "ratio",
      class: "hard",
      direction: "higher-worse",
    },
  };

  it("does NOT fail when batching improves (fewer transactions than baseline)", () => {
    const r = evaluate(
      report([
        {
          key: "index.txn_count",
          value: 1,
          unit: "count",
          class: "hard",
          direction: "higher-worse",
        },
      ]),
      txnBaseline,
    );
    expect(r.hardFailures).toHaveLength(0);
  });

  it("hard-fails when batching regresses (more transactions than baseline + tol)", () => {
    const r = evaluate(
      report([
        {
          key: "index.txn_count",
          value: 10,
          unit: "count",
          class: "hard",
          direction: "higher-worse",
        },
      ]),
      txnBaseline,
    );
    expect(r.hardFailures.map((v) => v.key)).toEqual(["index.txn_count"]);
  });

  it("tolerates a small increase within tol", () => {
    const r = evaluate(
      // 3 * 1.15 = 3.45 -> 3 is still within tolerance, matching baseline exactly
      report([
        {
          key: "index.txn_count",
          value: 3,
          unit: "count",
          class: "hard",
          direction: "higher-worse",
        },
      ]),
      txnBaseline,
    );
    expect(r.hardFailures).toHaveLength(0);
  });
});
