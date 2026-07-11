// THE-399 — paired statistics for the eval gate. Pins: permutation p is ~1 under H0 (zero /
// symmetric deltas), small for a consistent effect, deterministic across runs (seeded PRNG),
// and the bootstrap CI brackets the sample mean.
import { describe, expect, it } from "vitest";
import { bootstrapMeanCI, describePaired, pairedPermutationTest } from "../eval/stats";

describe("THE-399 paired permutation test", () => {
  it("returns 1 for all-zero deltas (no signal)", () => {
    expect(pairedPermutationTest([0, 0, 0, 0])).toBe(1);
  });

  it("is high for a symmetric no-effect sample", () => {
    const deltas = [0.1, -0.1, 0.05, -0.05, 0.2, -0.2, 0.15, -0.15];
    expect(pairedPermutationTest(deltas)).toBeGreaterThan(0.5);
  });

  it("is small for a consistent positive effect", () => {
    const deltas = Array.from({ length: 24 }, (_, i) => 0.05 + (i % 5) * 0.01);
    expect(pairedPermutationTest(deltas)).toBeLessThan(0.01);
  });

  it("is deterministic (seeded PRNG)", () => {
    const deltas = [0.02, -0.01, 0.04, 0.0, 0.03, -0.02, 0.05, 0.01];
    expect(pairedPermutationTest(deltas)).toBe(pairedPermutationTest(deltas));
  });
});

describe("THE-399 bootstrap CI", () => {
  it("brackets the sample mean and is deterministic", () => {
    const deltas = [0.1, 0.2, 0.05, 0.15, 0.12, 0.08];
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const ci = bootstrapMeanCI(deltas);
    expect(ci.lo).toBeLessThanOrEqual(mean);
    expect(ci.hi).toBeGreaterThanOrEqual(mean);
    expect(bootstrapMeanCI(deltas)).toEqual(ci);
  });

  it("degenerates safely on empty input", () => {
    expect(bootstrapMeanCI([])).toEqual({ lo: 0, hi: 0 });
    expect(pairedPermutationTest([])).toBe(1);
  });
});

describe("THE-399 describePaired", () => {
  it("formats mean, CI, p and n", () => {
    const line = describePaired([0.1, 0.1, 0.1, 0.1], "Δx");
    expect(line).toContain("Δx");
    expect(line).toContain("+0.100");
    expect(line).toContain("permutation p=");
    expect(line).toContain("(n=4)");
  });
});
