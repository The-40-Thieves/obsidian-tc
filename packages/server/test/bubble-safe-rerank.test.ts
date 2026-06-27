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
});
