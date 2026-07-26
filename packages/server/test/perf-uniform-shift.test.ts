// THE-584 item 4: the probe-free comparability check.
//
// The fixtures below are the REAL incident, not invented numbers. Two independent CI recordings
// came back 40-90% worse on every warn metric with every hard-class count identical, and the
// CPU-only detector called the host clean. If this check had existed, it would have refused that
// recording — so the first test asserts exactly that, against the numbers from the ticket.
import { describe, expect, it } from "vitest";
import type { Baseline, PerfReport } from "../eval/perf/report";
import { detectUniformShift } from "../eval/perf/uniform-shift";

type Dir = Baseline[string]["direction"];

function baseline(
  entries: Array<[key: string, value: number, dir: Dir, cls: "hard" | "warn"]>,
): Baseline {
  const b: Baseline = {};
  for (const [key, value, direction, cls] of entries) {
    b[key] = { value, tol: 0.5, mode: "ratio", class: cls, direction };
  }
  return b;
}

function report(values: Record<string, number>): PerfReport {
  return {
    scenario: "small",
    samples: Object.entries(values).map(([key, value]) => ({
      key,
      value,
      unit: "ms" as const,
      class: "warn" as const,
      direction: "higher-worse" as const,
    })),
  };
}

// THE-584's recorded table, verbatim.
const INCIDENT_BASELINE = baseline([
  ["index.chunks_per_s", 2901.6, "lower-worse", "warn"],
  ["embed.texts_per_s", 1741.0, "lower-worse", "warn"],
  ["freshness.ms", 34.8, "higher-worse", "warn"],
  ["runtime.eventloop_p99_ms", 37.4, "higher-worse", "warn"],
  ["http.cold_ms", 14.3, "higher-worse", "warn"],
  ["storage.txn_ms", 0.52, "higher-worse", "warn"],
  ["index.chunk_count", 200, "exact", "hard"],
  ["index.txn_count", 3, "exact", "hard"],
]);

const INCIDENT_REPORT = report({
  "index.chunks_per_s": 1567,
  "embed.texts_per_s": 940,
  "freshness.ms": 68.3,
  "runtime.eventloop_p99_ms": 65,
  "http.cold_ms": 22.2,
  "storage.txn_ms": 0.85,
  "index.chunk_count": 200, // unchanged — the control group
  "index.txn_count": 3, // unchanged
});

describe("THE-584 item 4 — uniform workload shift", () => {
  it("refuses the actual incident: everything slower, nothing counted differently", () => {
    const r = detectUniformShift(INCIDENT_REPORT, INCIDENT_BASELINE);
    expect(r.suspect).toBe(true);
    expect(r.movedWorse).toHaveLength(6);
    expect(r.comparable).toBe(6);
    expect(r.hardChanged).toEqual([]);
    // The recorded shift was 1.5x-2x across the board.
    expect(r.medianFactor).toBeGreaterThan(1.5);
    expect(r.medianFactor).toBeLessThan(2.1);
    expect(r.reason).toMatch(/slower HOST, not a slower build/);
  });

  // The load-bearing distinction. Hard-class metrics are the control group: they are
  // seed-deterministic counts that cannot move because a machine got slower. If one moved, the
  // WORKLOAD changed, and a uniform slowdown is then attributable to the code — which is the
  // ordinary gate's job, not a host-comparability heuristic's.
  it("stands down when ANY hard-class count changed — that is a code change, not a host", () => {
    const withCodeChange = report({
      "index.chunks_per_s": 1567,
      "embed.texts_per_s": 940,
      "freshness.ms": 68.3,
      "runtime.eventloop_p99_ms": 65,
      "http.cold_ms": 22.2,
      "storage.txn_ms": 0.85,
      "index.chunk_count": 200,
      "index.txn_count": 5, // <- the build now writes more transactions
    });
    const r = detectUniformShift(withCodeChange, INCIDENT_BASELINE);
    expect(r.suspect).toBe(false);
    expect(r.hardChanged).toEqual(["index.txn_count"]);
  });

  it("does not fire on a normal run with ordinary noise", () => {
    const noisy = report({
      "index.chunks_per_s": 2850, // ~2% worse
      "embed.texts_per_s": 1800, // better
      "freshness.ms": 35.9, // ~3% worse
      "runtime.eventloop_p99_ms": 36.0, // better
      "http.cold_ms": 15.1, // ~6% worse
      "storage.txn_ms": 0.51, // better
      "index.chunk_count": 200,
      "index.txn_count": 3,
    });
    const r = detectUniformShift(noisy, INCIDENT_BASELINE);
    expect(r.suspect).toBe(false);
    expect(r.movedWorse).toEqual([]);
  });

  it("does not fire when ONE metric regresses badly — that is a real regression, for the gate", () => {
    // A single 3x regression is exactly what the ordinary gate exists to catch. Flagging it here
    // as "the host is not comparable" would misattribute a genuine code problem to the machine.
    const oneBad = report({
      "index.chunks_per_s": 2901.6,
      "embed.texts_per_s": 1741.0,
      "freshness.ms": 104.4, // 3x worse, alone
      "runtime.eventloop_p99_ms": 37.4,
      "http.cold_ms": 14.3,
      "storage.txn_ms": 0.52,
      "index.chunk_count": 200,
      "index.txn_count": 3,
    });
    const r = detectUniformShift(oneBad, INCIDENT_BASELINE);
    expect(r.suspect).toBe(false);
    expect(r.movedWorse).toEqual(["freshness.ms"]);
  });

  it("stands down below the comparable-metric floor, where 'most moved' means nothing", () => {
    const tiny = baseline([
      ["a.ms", 10, "higher-worse", "warn"],
      ["b.ms", 10, "higher-worse", "warn"],
    ]);
    const r = detectUniformShift(report({ "a.ms": 30, "b.ms": 30 }), tiny);
    // 2/2 moved, but two metrics cannot establish a workload-wide pattern.
    expect(r.comparable).toBe(2);
    expect(r.suspect).toBe(false);
  });

  it("ignores `exact` warn metrics, which have no worse direction", () => {
    const withExact = baseline([
      ["ratio.thing", 0.5, "exact", "warn"],
      ["a.ms", 10, "higher-worse", "warn"],
      ["b.ms", 10, "higher-worse", "warn"],
      ["c.ms", 10, "higher-worse", "warn"],
      ["d.ms", 10, "higher-worse", "warn"],
    ]);
    const r = detectUniformShift(
      report({ "ratio.thing": 0.9, "a.ms": 30, "b.ms": 30, "c.ms": 30, "d.ms": 30 }),
      withExact,
    );
    expect(r.comparable).toBe(4); // the exact metric is not counted either way
    expect(r.movedWorse).not.toContain("ratio.thing");
    expect(r.suspect).toBe(true);
  });

  it("ignores metrics missing from the report — that is the gate's `missing` violation", () => {
    const r = detectUniformShift(report({ "freshness.ms": 68.3 }), INCIDENT_BASELINE);
    expect(r.comparable).toBe(1);
    expect(r.suspect).toBe(false); // below the floor, and not this check's failure to report
  });

  it("respects custom thresholds", () => {
    const strict = detectUniformShift(INCIDENT_REPORT, INCIDENT_BASELINE, { minFactor: 3 });
    expect(strict.suspect).toBe(false); // nothing was 3x worse
    const lax = detectUniformShift(INCIDENT_REPORT, INCIDENT_BASELINE, { minFraction: 0.95 });
    expect(lax.suspect).toBe(true); // 6/6 clears even 95%
  });

  it("treats a uniform IMPROVEMENT as not suspect", () => {
    // Everything got faster with counts unchanged. Suspicious in its own way (gate.ts's STALE
    // BASELINE handles that), but it is not the "do not record this" case — refusing to record an
    // improvement would make a genuine win impossible to bank.
    const faster = report({
      "index.chunks_per_s": 5000,
      "embed.texts_per_s": 3000,
      "freshness.ms": 17,
      "runtime.eventloop_p99_ms": 18,
      "http.cold_ms": 7,
      "storage.txn_ms": 0.25,
      "index.chunk_count": 200,
      "index.txn_count": 3,
    });
    const r = detectUniformShift(faster, INCIDENT_BASELINE);
    expect(r.suspect).toBe(false);
    expect(r.movedWorse).toEqual([]);
  });
});
