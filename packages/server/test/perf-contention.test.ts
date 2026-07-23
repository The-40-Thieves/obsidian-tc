import { describe, expect, it } from "vitest";
import {
  calibrate,
  coefficientOfVariation,
  detectContention,
  median,
} from "../eval/perf/contention";

describe("perf contention detector (THE-503)", () => {
  it("median() handles odd and even length arrays", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it("coefficientOfVariation() is 0 for identical samples and a single sample", () => {
    expect(coefficientOfVariation([10, 10, 10])).toBe(0);
    expect(coefficientOfVariation([42])).toBe(0);
    expect(coefficientOfVariation([])).toBe(0);
  });

  it("coefficientOfVariation() is positive for a noisy series", () => {
    expect(coefficientOfVariation([10, 20, 10, 20])).toBeGreaterThan(0);
  });

  it("detectContention() passes a tight, quiet-host-like series", () => {
    const r = detectContention([20, 21, 19, 20, 22]);
    expect(r.contended).toBe(false);
    expect(r.reason).toBeUndefined();
  });

  it("detectContention() flags a noisy series (comes-and-goes contention)", () => {
    const r = detectContention([20, 60, 22, 55, 21]);
    expect(r.contended).toBe(true);
    expect(r.reason).toMatch(/CV/);
  });

  it("detectContention() flags a single stalled outlier even with low overall CV budget", () => {
    // four tight samples plus one that is 2x the median -- CV alone might not clear a loose
    // threshold, but the max/median check must still catch the stall.
    const r = detectContention([20, 20, 21, 19, 45], { cvThreshold: 0.5 });
    expect(r.contended).toBe(true);
    expect(r.reason).toMatch(/median/);
  });

  it("detectContention() respects custom thresholds", () => {
    const noisy = [20, 30, 20, 30];
    expect(detectContention(noisy, { cvThreshold: 0.5 }).contended).toBe(false);
    expect(detectContention(noisy, { cvThreshold: 0.05 }).contended).toBe(true);
  });

  // Empirically discovered gap: SUSTAINED, uniform contention (every sample slowed by roughly the
  // same amount -- e.g. the Vitest suite running the entire time, the original incident) produces
  // a TIGHT spread and would pass the relative checks above. The absolute reference check exists
  // specifically to catch this.
  it("passes a tight series near the committed reference", () => {
    const r = detectContention([20, 21, 19, 20, 22], { referenceMs: 20 });
    expect(r.contended).toBe(false);
  });

  it("flags a tight-but-uniformly-slow series against the committed reference (sustained load)", () => {
    const r = detectContention([40, 41, 39, 40, 42], { referenceMs: 20 });
    expect(r.contended).toBe(true);
    expect(r.reason).toMatch(/reference/);
  });

  it("does not apply the reference check when no reference is given", () => {
    const r = detectContention([40, 41, 39, 40, 42]);
    expect(r.contended).toBe(false);
  });

  it("respects a custom referenceTol", () => {
    const series = [29, 30, 31, 29, 30]; // ~50% above a reference of 20
    expect(detectContention(series, { referenceMs: 20, referenceTol: 1.0 }).contended).toBe(false);
    expect(detectContention(series, { referenceMs: 20, referenceTol: 0.1 }).contended).toBe(true);
  });

  it("calibrate() returns a positive, finite wall-time measurement", () => {
    const ms = calibrate(1_000_000); // small iteration count -- this is a unit test, not a bench
    expect(ms).toBeGreaterThan(0);
    expect(Number.isFinite(ms)).toBe(true);
  });
});
