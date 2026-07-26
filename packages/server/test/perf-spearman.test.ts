// THE-594: pure-math tests for eval/perf/spearman.ts. No real timing anywhere in this file — that
// is the point. The actual calibrateIo() scaling check (real elapsed time, gated on the median of
// N isolated subprocess samples) lives in the perf harness now (contention.ts's
// measureIoScalingRho(), wired into run.ts's `main()`); what belongs in the unit suite is proving
// the STATISTIC has power, which is a deterministic computation over synthetic series and needs
// no wall clock at all.
import { describe, expect, it } from "vitest";
import {
  rank,
  SPEARMAN_SIZES,
  SPEARMAN_THRESHOLD,
  spearmanFor,
  spearmanRankCorrelation,
} from "../eval/perf/spearman";

describe("THE-594 rank()", () => {
  it("ranks a strictly increasing series 0..n-1", () => {
    expect(rank([10, 20, 30, 40])).toEqual([0, 1, 2, 3]);
  });

  it("ranks a strictly decreasing series n-1..0", () => {
    expect(rank([40, 30, 20, 10])).toEqual([3, 2, 1, 0]);
  });

  it("gives tied values the average of the ranks they span", () => {
    // Two values tie for ranks 1 and 2 (0-based) -> both get 1.5.
    expect(rank([10, 20, 20, 40])).toEqual([0, 1.5, 1.5, 3]);
  });
});

describe("THE-594 spearmanRankCorrelation()", () => {
  it("is 1 for a perfectly increasing relationship", () => {
    expect(spearmanRankCorrelation([1, 2, 3, 4, 5], [10, 20, 30, 40, 50])).toBeCloseTo(1, 10);
  });

  it("is -1 for a perfectly decreasing relationship", () => {
    expect(spearmanRankCorrelation([1, 2, 3, 4, 5], [50, 40, 30, 20, 10])).toBeCloseTo(-1, 10);
  });

  it("is 0 when either series has no variance (a constant)", () => {
    expect(spearmanRankCorrelation([1, 2, 3], [5, 5, 5])).toBe(0);
  });
});

// THE-594's acceptance criterion, carried over from PR #496: whatever replaces the old two-point
// `>` must still demonstrably FAIL against a calibrateIo that does not measure real work. Proven
// here directly and deterministically -- no timing, no RNG, no repeated trials, reproducible on
// every host and every run -- rather than only asserted on faith.
describe("THE-594 calibration has power (constant-stub proof)", () => {
  it("rejects a constant-duration stub, proving the calibration has power", () => {
    let calls = 0;
    // ~50-54ms, cycling independently of the requested size -- a stand-in for "the loop stopped
    // measuring anything and duration no longer tracks the work requested".
    const constantStub = (_rounds: number) => 50 + ((calls++ * 7) % 5);
    const rho = spearmanFor(constantStub, SPEARMAN_SIZES);
    expect(rho).toBeLessThanOrEqual(SPEARMAN_THRESHOLD);
  });

  it("accepts a genuinely scaling stub, so the threshold does not reject everything", () => {
    const linearStub = (rounds: number) => rounds * 2 + 1;
    const rho = spearmanFor(linearStub, SPEARMAN_SIZES);
    expect(rho).toBeGreaterThan(SPEARMAN_THRESHOLD);
  });
});
