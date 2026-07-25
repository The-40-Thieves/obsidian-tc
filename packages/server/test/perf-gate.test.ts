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

/** A baseline narrowed to just the metrics a test actually supplies.
 *
 *  THE-534 made every baselined metric a claim the report must answer — a baselined key with no
 *  sample is now a "missing" violation, which is what gives the gate its non-empty floor. The
 *  single-metric tests below are unit tests of the VIOLATION PREDICATE, not of coverage, so they
 *  declare the subset they are exercising rather than inheriting two unrelated metrics and
 *  collecting spurious missing-metric failures. Coverage gets its own describe block further down. */
function only(...keys: Array<keyof typeof baseline>): Baseline {
  return Object.fromEntries(keys.map((k) => [k, baseline[k] as Baseline[string]]));
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
      only("index.chunks_per_s"),
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
      only("index.chunks_per_s"),
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
      only("embed.dup_ratio"),
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
      only("dispatch.p95_ms"),
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

// THE-534 step 4 — the PERF GATE AUDIT the ticket asks for.
//
// Motivating evidence from the ticket: "CI's `perf` check passed THE-486's 113× improvement
// without comment." Probing evaluate() directly showed the gate is blind in three ways, and all
// three report `perf gate OK`:
//
//   1. an EMPTY report (harness produced nothing at all)
//   2. a baselined metric that silently stops being emitted
//   3. a key renamed upstream, carrying a 100× REGRESSION, which lands in no baseline entry
//
// All three share one cause: evaluate() iterated the REPORT and looked up the baseline, so
// anything the report failed to mention was unreachable. `if (!b) continue` made an unrecognised
// key "informational", and a baselined key with no sample was never visited at all. A gate that
// only inspects what it was handed cannot notice what it was not handed — the same class as the
// empty-scan false pass recorded in the repo's own perf README.
//
// The fix inverts the iteration: walk the BASELINE and require each entry to be covered.
describe("THE-534 perf gate audit — coverage (a gate must notice what it was NOT handed)", () => {
  const twoHard: Baseline = {
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
  };

  it("hard-fails an EMPTY report instead of reporting OK (the non-empty floor)", () => {
    const r = evaluate(report([]), twoHard);
    expect(r.hardFailures.map((v) => v.key).sort()).toEqual([
      "embed.dup_ratio",
      "index.chunks_per_s",
    ]);
    expect(r.hardFailures.every((v) => v.reason === "missing")).toBe(true);
  });

  it("hard-fails when a baselined metric silently stops being emitted", () => {
    const r = evaluate(
      report([
        {
          key: "index.chunks_per_s",
          value: 4000,
          unit: "per_s",
          class: "hard",
          direction: "lower-worse",
        },
      ]),
      twoHard,
    );
    // The metric that IS present is healthy; the absent one must still be caught.
    expect(r.hardFailures.map((v) => v.key)).toEqual(["embed.dup_ratio"]);
    expect(r.hardFailures[0]?.reason).toBe("missing");
  });

  it("an unrecognised key cannot mask a missing baselined metric (renamed-key regression)", () => {
    // The renamed key carries a catastrophic value. Before the fix this returned zero violations:
    // the bad value was unbaselined ("informational"), and the real metric was simply never visited.
    const r = evaluate(
      report([
        {
          key: "index.chunks_per_s_v2",
          value: 1,
          unit: "per_s",
          class: "hard",
          direction: "lower-worse",
        },
        {
          key: "embed.dup_ratio",
          value: 0.5,
          unit: "ratio",
          class: "hard",
          direction: "higher-worse",
        },
      ]),
      twoHard,
    );
    expect(r.hardFailures.map((v) => v.key)).toEqual(["index.chunks_per_s"]);
    expect(r.hardFailures[0]?.reason).toBe("missing");
  });

  it("a MISSING warn-class metric warns rather than hard-failing (class is preserved)", () => {
    const warnOnly: Baseline = {
      "dispatch.p95_ms": {
        value: 10,
        tol: 0.4,
        mode: "ratio",
        class: "warn",
        direction: "higher-worse",
      },
    };
    const r = evaluate(report([]), warnOnly);
    expect(r.hardFailures).toHaveLength(0);
    expect(r.warnings.map((v) => v.key)).toEqual(["dispatch.p95_ms"]);
    expect(r.warnings[0]?.reason).toBe("missing");
  });
});

describe("THE-534 perf gate audit — large improvements must be REPORTED, never silently accepted", () => {
  // An improvement must never fail CI (that would block good changes), but it must not pass
  // "without comment" either: a 113× improvement means the committed baseline no longer describes
  // the system, and the next reader cites a stale reference in a go/no-go. That is precisely the
  // decision THE-467/THE-468 are gated on.
  const b: Baseline = {
    "knn.wall_ms": {
      value: 81338,
      tol: 0.15,
      mode: "ratio",
      class: "hard",
      direction: "higher-worse",
    },
  };

  it("flags THE-486's real 113x improvement as a stale baseline", () => {
    // The actual measured numbers from THE-486: 81,338 ms -> 714 ms.
    const r = evaluate(
      report([
        { key: "knn.wall_ms", value: 714, unit: "ms", class: "hard", direction: "higher-worse" },
      ]),
      b,
    );
    expect(r.hardFailures).toHaveLength(0); // an improvement NEVER fails
    expect(r.stale.map((s) => s.key)).toEqual(["knn.wall_ms"]);
    expect(r.stale[0]?.factor).toBeGreaterThan(100); // ~113x
  });

  it("does NOT flag an ordinary within-noise improvement as stale", () => {
    const r = evaluate(
      report([
        { key: "knn.wall_ms", value: 80000, unit: "ms", class: "hard", direction: "higher-worse" },
      ]),
      b,
    );
    expect(r.stale).toHaveLength(0);
  });
});
