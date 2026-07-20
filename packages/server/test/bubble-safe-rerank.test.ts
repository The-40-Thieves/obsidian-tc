import { describe, expect, it } from "vitest";
import {
  ACTIVATION_MULTIPLIER_RANGE,
  activationMultiplier,
  bubbleSafeRerank,
} from "../src/search/bubble_safe_rerank";

describe("bubble_safe_rerank (port)", () => {
  it("activationMultiplier is inert at 0.5 and bounded ±range/2", () => {
    expect(activationMultiplier(0.5)).toBeCloseTo(1.0);
    expect(activationMultiplier(null)).toBeCloseTo(1.0);
    expect(activationMultiplier(undefined)).toBeCloseTo(1.0);
    expect(activationMultiplier(1.0)).toBeCloseTo(1 + ACTIVATION_MULTIPLIER_RANGE / 2); // 1.2
    expect(activationMultiplier(0.0)).toBeCloseTo(1 - ACTIVATION_MULTIPLIER_RANGE / 2); // 0.8
  });

  it("swaps an adjacent pair when activation flips the adjusted order", () => {
    // a: 1.0 * 0.8 = 0.80 ; b: 0.9 * 1.2 = 1.08 -> b should move ahead of a.
    const out = bubbleSafeRerank([
      { id: "a", rerankScore: 1.0, activationScore: 0.0 },
      { id: "b", rerankScore: 0.9, activationScore: 1.0 },
    ]);
    expect(out.map((x) => x.id)).toEqual(["b", "a"]);
  });

  it("is inert when activation is absent (rerank order preserved)", () => {
    const out = bubbleSafeRerank([
      { id: "a", rerankScore: 0.9 },
      { id: "b", rerankScore: 0.8 },
      { id: "c", rerankScore: 0.7 },
    ]);
    expect(out.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("moves each item by at most one position (single bubble pass)", () => {
    // Strong activation on the last item must not let it jump more than one slot.
    const items = [
      { id: "a", rerankScore: 1.0, activationScore: 0.5 },
      { id: "b", rerankScore: 0.99, activationScore: 0.5 },
      { id: "c", rerankScore: 0.98, activationScore: 1.0 },
    ];
    const out = bubbleSafeRerank(items);
    const finalIdx = new Map(out.map((x, i) => [x.id, i]));
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;
      expect(Math.abs((finalIdx.get(item.id) ?? i) - i)).toBeLessThanOrEqual(1);
    }
  });

  it("one-position bound holds under an adversarial fully-inverted signal", () => {
    // Trusted order is strictly descending with TINY gaps (0.001), so the activation signal
    // dominates each adjacent comparison. Activation is inverted vs the trusted order — every
    // later item screams "promote me" — the maximally hostile input for the bound. A single
    // bubble pass with the moved-flag must STILL never move any item more than one index.
    const n = 12;
    const items = Array.from({ length: n }, (_, i) => ({
      id: `x${i}`,
      rerankScore: 1 - i * 0.001, // trusted: descending
      activationScore: i / (n - 1), // adversarial: ascending (last item strongest)
    }));
    const out = bubbleSafeRerank(items);
    expect(out).toHaveLength(n);
    const finalIdx = new Map(out.map((x, i) => [x.id, i]));
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      const item = items[i];
      if (!item) continue;
      maxDelta = Math.max(maxDelta, Math.abs((finalIdx.get(item.id) ?? i) - i));
    }
    expect(maxDelta).toBeLessThanOrEqual(1);
    // Output is a permutation of the input (nothing dropped or duplicated).
    expect(new Set(out.map((x) => x.id)).size).toBe(n);
  });

  it("k scales the multiplier: a swap that the default k makes is suppressed at small k", () => {
    // a(1.0,s=0) vs b(0.9,s=1): swap iff 0.9(1+0.5k) > 1.0(1-0.5k)  <=>  k > ~0.105.
    const pair = () => [
      { id: "a", rerankScore: 1.0, activationScore: 0.0 },
      { id: "b", rerankScore: 0.9, activationScore: 1.0 },
    ];
    expect(bubbleSafeRerank(pair(), { k: 0.1 }).map((x) => x.id)).toEqual(["a", "b"]); // inert
    expect(bubbleSafeRerank(pair(), { k: 0.4 }).map((x) => x.id)).toEqual(["b", "a"]); // swaps
    expect(bubbleSafeRerank(pair()).map((x) => x.id)).toEqual(["b", "a"]); // default k = 0.4
    // activationMultiplier itself scales linearly with k and stays inert at 0.5 for any k.
    expect(activationMultiplier(1.0, 0.1)).toBeCloseTo(1.05);
    expect(activationMultiplier(1.0, 1.0)).toBeCloseTo(1.5);
    expect(activationMultiplier(0.5, 1.0)).toBeCloseTo(1.0);
  });

  it("empty and single-item arrays are no-ops and the input is never mutated", () => {
    expect(bubbleSafeRerank([])).toEqual([]);
    const single = [{ id: "only", rerankScore: 0.7, activationScore: 1.0 }];
    expect(bubbleSafeRerank(single).map((x) => x.id)).toEqual(["only"]);

    const input = [
      { id: "a", rerankScore: 0.8, activationScore: 0.0 },
      { id: "b", rerankScore: 0.7, activationScore: 1.0 },
    ];
    const snapshot = input.map((x) => x.id);
    const out = bubbleSafeRerank(input);
    expect(out).not.toBe(input); // new array
    expect(input.map((x) => x.id)).toEqual(snapshot); // input order untouched
    expect(out.map((x) => x.id)).toEqual(["b", "a"]); // returned copy is reordered
  });
});
