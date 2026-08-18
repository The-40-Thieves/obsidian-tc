// Pure-math tests — no @huggingface/transformers, no model weights, no I/O. These always run.
import { describe, expect, it } from "vitest";
import { rankLogits } from "../src/index.js";

describe("rankLogits", () => {
  it("sigmoid-squashes logits and sorts descending by relevance", () => {
    // logits (in input order): doc0 weak-negative, doc1 strongly positive, doc2 mildly positive
    const hits = rankLogits([-2, 5, 1], 0);
    expect(hits.map((h) => h.index)).toEqual([1, 2, 0]);
    for (const h of hits) {
      expect(h.relevanceScore).toBeGreaterThan(0);
      expect(h.relevanceScore).toBeLessThan(1);
    }
    expect(hits[0]?.relevanceScore).toBeGreaterThan(hits[1]?.relevanceScore ?? 0);
    expect(hits[1]?.relevanceScore).toBeGreaterThan(hits[2]?.relevanceScore ?? 0);
  });

  it("truncates to topN when topN is positive", () => {
    const hits = rankLogits([0, 3, -3, 1], 2);
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.index)).toEqual([1, 3]);
  });

  it("returns every hit when topN is 0 (no truncation), matching the cohere-compatible convention", () => {
    const hits = rankLogits([0, 1, 2, 3], 0);
    expect(hits).toHaveLength(4);
  });

  it("returns every hit when topN is negative", () => {
    const hits = rankLogits([0, 1], -1);
    expect(hits).toHaveLength(2);
  });

  it("handles a single document", () => {
    const hits = rankLogits([4.2], 5);
    expect(hits).toEqual([{ index: 0, relevanceScore: expect.any(Number) }]);
  });

  it("handles zero documents", () => {
    expect(rankLogits([], 3)).toEqual([]);
  });

  it("is a stable ordering keyed only on the logit, independent of the caller's topN slicing", () => {
    const full = rankLogits([1, 2, 3], 0);
    const truncated = rankLogits([1, 2, 3], 2);
    expect(truncated).toEqual(full.slice(0, 2));
  });
});
