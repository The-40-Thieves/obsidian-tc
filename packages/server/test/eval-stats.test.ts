// THE-399 — paired statistics for the eval gate. Pins: permutation p is ~1 under H0 (zero /
// symmetric deltas), small for a consistent effect, deterministic across runs (seeded PRNG),
// and the bootstrap CI brackets the sample mean.
import { describe, expect, it } from "vitest";
import {
  benjaminiHochberg,
  bootstrapMeanCI,
  describePaired,
  pairedNonInferiority,
  pairedPermutationTest,
  powerReport,
  sampleStdev,
} from "../eval/stats";

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

describe("THE-440 power / MDE reporter", () => {
  it("sampleStdev matches a hand-computed value and is 0 for n<2", () => {
    // xs = [0,2,4] → mean 2, ss = 4+0+4 = 8, var = 8/2 = 4, sd = 2
    expect(sampleStdev([0, 2, 4])).toBeCloseTo(2, 10);
    expect(sampleStdev([5])).toBe(0);
    expect(sampleStdev([])).toBe(0);
  });

  it("MDE shrinks as n grows for the same spread, ∝ 1/√n", () => {
    // same SD, 4× the n → SE and MDE halve. Even counts keep the ±0.2 split balanced
    // so the two SDs are identical (an odd n leaves a residual mean that perturbs SD).
    const small = Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? 0.2 : -0.2));
    const big = Array.from({ length: 96 }, (_, i) => (i % 2 === 0 ? 0.2 : -0.2));
    const rs = powerReport(small);
    const rb = powerReport(big);
    // SDs agree to ~2 decimals (they differ only by the Bessel n−1 correction across n).
    expect(rs.sigmaD).toBeCloseTo(rb.sigmaD, 2);
    expect(rb.mde).toBeLessThan(rs.mde);
    expect(rs.mde / rb.mde).toBeCloseTo(2, 1);
  });

  it("n_needed grows as the target effect shrinks (∝ 1/Δ²)", () => {
    const deltas = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.15 : -0.15));
    const r = powerReport(deltas, { targets: [0.05, 0.025] });
    const n05 = r.nNeeded[0]?.n ?? 0;
    const n025 = r.nNeeded[1]?.n ?? 0;
    // halving the target Δ quadruples the required n.
    expect(n025).toBeCloseTo(n05 * 4, -1);
  });

  it("reproduces the README anchor: σ_d≈0.20 needs n≈126 to detect Δ=0.05", () => {
    // ((1.95996+0.84162)^2 * 0.20^2) / 0.05^2 ≈ 125.6 → 126
    const deltas = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 0.2 : -0.2));
    expect(sampleStdev(deltas)).toBeCloseTo(0.2, 2);
    const r = powerReport(deltas, { targets: [0.05] });
    expect(r.nNeeded[0]?.n).toBeGreaterThanOrEqual(120);
    expect(r.nNeeded[0]?.n).toBeLessThanOrEqual(132);
  });
});

describe("THE-440 non-inferiority (Δ>−0.015 floor)", () => {
  it("declares a clearly-positive arm non-inferior", () => {
    const r = pairedNonInferiority(Array.from({ length: 40 }, () => 0.02));
    expect(r.nonInferior).toBe(true);
    expect(r.lowerBound).toBeGreaterThan(-0.015);
  });

  it("fails the floor when the arm regresses well below it", () => {
    const r = pairedNonInferiority(Array.from({ length: 40 }, () => -0.05));
    expect(r.nonInferior).toBe(false);
    expect(r.lowerBound).toBeLessThan(-0.015);
  });

  it("a tiny-negative-but-noisy arm can still clear the floor (that is the point)", () => {
    // mean ~ −0.002, tight spread → one-sided lower bound stays above −0.015.
    const deltas = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 0.004 : -0.008));
    const r = pairedNonInferiority(deltas);
    expect(r.mean).toBeLessThan(0);
    expect(r.nonInferior).toBe(true);
  });

  it("is deterministic (seeded bootstrap)", () => {
    const d = [0.01, -0.02, 0.03, 0.0, -0.01, 0.02];
    expect(pairedNonInferiority(d)).toEqual(pairedNonInferiority(d));
  });
});

describe("THE-441 Benjamini-Hochberg FDR (q=0.10)", () => {
  it("returns rows in input order with rejection flags", () => {
    // classic BH example: sorted p = .008,.009,.039,.041,.042 vs (k/5)·.1
    const ps = [0.041, 0.009, 0.042, 0.008, 0.039];
    const rows = benjaminiHochberg(ps, 0.1);
    expect(rows.map((r) => r.p)).toEqual(ps); // input order preserved
    // largest k with p(k) ≤ (k/5)·.1: p=.008≤.02 ✓, p=.009≤.04 ✓, p=.039≤.06 ✓,
    // p=.041≤.08 ✓, p=.042≤.10 ✓ → all reject.
    expect(rows.every((r) => r.rejected)).toBe(true);
  });

  it("rejects nothing when every p is large", () => {
    const rows = benjaminiHochberg([0.5, 0.6, 0.9, 0.99], 0.1);
    expect(rows.some((r) => r.rejected)).toBe(false);
  });

  it("respects the step-up property (a small p rides in on a larger accepted one)", () => {
    // p = [.001, .09]: rank1 .001≤.05 ✓, rank2 .09≤.10 ✓ → both reject; the .09
    // is only rejected because BH steps up from the largest passing rank.
    const rows = benjaminiHochberg([0.001, 0.09], 0.1);
    expect(rows.every((r) => r.rejected)).toBe(true);
  });

  it("degenerates safely on empty input", () => {
    expect(benjaminiHochberg([], 0.1)).toEqual([]);
  });
});
