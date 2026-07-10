// THE-387 — Matryoshka (MRL) dimension truncation in assertVectors. Lets a wider MRL model (e.g.
// Qwen3-8B at 4096) be stored at a smaller `dimensions`, while a genuine non-MRL width mismatch
// still errors rather than silently truncating into meaningless prefixes.
import { describe, expect, it } from "vitest";
import { assertVectors } from "../src/embeddings/provider";

function norm(v: number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

describe("assertVectors MRL truncation (THE-387)", () => {
  it("passes exact-width vectors through unchanged", () => {
    const v = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    expect(assertVectors(v, 3, 2)).toEqual(v);
  });

  it("truncates + renormalises a wider vector when truncate is on", () => {
    const out = assertVectors([[3, 4, 99, 99]], 2, 1, { truncate: true });
    // First 2 components [3,4] renormalised to unit length -> [0.6, 0.8].
    expect(out[0]?.length).toBe(2);
    expect(norm(out[0] as number[])).toBeCloseTo(1);
    expect(out[0]?.[0]).toBeCloseTo(0.6);
    expect(out[0]?.[1]).toBeCloseTo(0.8);
  });

  it("rejects a wider vector when truncate is off (no silent truncation)", () => {
    expect(() => assertVectors([[1, 2, 3, 4]], 2, 1)).toThrow();
    expect(() => assertVectors([[1, 2, 3, 4]], 2, 1, { truncate: false })).toThrow();
  });

  it("rejects a narrower vector even with truncate on (cannot pad)", () => {
    expect(() => assertVectors([[1, 2]], 4, 1, { truncate: true })).toThrow();
  });

  it("rejects non-finite components", () => {
    expect(() => assertVectors([[1, Number.NaN, 3]], 3, 1)).toThrow();
  });

  it("rejects the wrong number of vectors", () => {
    expect(() => assertVectors([[1, 2, 3]], 3, 2)).toThrow();
  });
});
