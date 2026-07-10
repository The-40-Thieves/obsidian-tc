// THE-388 — ColBERT late-interaction (maxSim) scorer + reranker. Pure functions, hand-built token
// matrices; the bge-m3 encoder that produces the matrices is separate and infra-gated.
import { describe, expect, it } from "vitest";
import { colbertRerank, maxSim } from "../src/search/colbert";

describe("ColBERT maxSim + rerank (THE-388)", () => {
  it("maxSim sums each query token's max cosine to the doc tokens", () => {
    const q = [
      [1, 0],
      [0, 1],
    ];
    const doc = [
      [1, 0],
      [0, 1],
      [1, 1],
    ];
    expect(maxSim(q, doc)).toBeCloseTo(2); // 1 + 1
  });

  it("maxSim is 0 for an empty side", () => {
    expect(maxSim([], [[1, 0]])).toBe(0);
    expect(maxSim([[1, 0]], [])).toBe(0);
  });

  it("colbertRerank orders by maxSim, and is a no-op without doc data or query", () => {
    const items = [{ chunk_id: "a" }, { chunk_id: "b" }, { chunk_id: "c" }];
    const query = [[1, 0]];
    const docs = new Map<string, number[][]>([
      ["a", [[0, 1]]], // cos 0
      ["b", [[1, 0]]], // cos 1 (best)
      ["c", [[0.7, 0.7]]], // cos ~0.707
    ]);
    expect(colbertRerank(items, query, docs).map((i) => i.chunk_id)).toEqual(["b", "c", "a"]);
    // No ColBERT data at all -> input order preserved.
    expect(colbertRerank(items, query, new Map()).map((i) => i.chunk_id)).toEqual(["a", "b", "c"]);
    // Empty query -> input order.
    expect(colbertRerank(items, [], docs).map((i) => i.chunk_id)).toEqual(["a", "b", "c"]);
  });
});
