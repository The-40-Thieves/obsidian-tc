// THE-388 — ColBERT late-interaction (maxSim) scorer + reranker. Pure functions, hand-built token
// matrices; the bge-m3 encoder that produces the matrices is separate and infra-gated.
import { describe, expect, it } from "vitest";
import { type ColbertMatrix, colbertRerank, maxSim } from "../src/search/colbert";

/** Pre-THE-418 implementation, pinned here so the batched-cosine rewrite in colbert.ts can be
 *  checked against it directly rather than against a value baked into the test. */
function maxSimPairwiseReference(query: ColbertMatrix, doc: ColbertMatrix): number {
  if (query.length === 0 || doc.length === 0) return 0;
  let total = 0;
  for (const q of query) {
    let best = Number.NEGATIVE_INFINITY;
    for (const d of doc) {
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < q.length; i++) {
        const x = q[i] ?? 0;
        const y = d[i] ?? 0;
        dot += x * y;
        na += x * x;
        nb += y * y;
      }
      const s =
        q.length !== d.length || na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
      if (s > best) best = s;
    }
    total += best === Number.NEGATIVE_INFINITY ? 0 : best;
  }
  return total;
}

/** Deterministic pseudo-random ColBERT-shaped matrix (no Date/Math.random — reproducible). */
function fixtureMatrix(seed: number, tokens: number, dim: number): ColbertMatrix {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  return Array.from({ length: tokens }, () => Array.from({ length: dim }, () => rnd() * 2 - 1));
}

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

  // THE-418: colbert.ts's inner loop moved from one jsCosineSimilarity call per (query-token,
  // doc-token) pair to one batched cosineBatch crossing per query token. This is the safety net
  // for that swap: pin maxSim's output against the pre-THE-418 pairwise implementation
  // (`maxSimPairwiseReference` above, copied verbatim from the prior colbert.ts) on realistic
  // multi-token, multi-dimension fixtures. `toBeCloseTo` (not `toBe`) because the batched path
  // round-trips each query token through a Float32Array — matching semantic.ts's existing
  // native-boundary precedent — so results agree within float tolerance, not bit-for-bit.
  it("maxSim matches the pre-THE-418 pairwise implementation (rectangular doc matrices)", () => {
    const cases: Array<{ tokens: number; docTokens: number; dim: number }> = [
      { tokens: 1, docTokens: 1, dim: 1 },
      { tokens: 4, docTokens: 40, dim: 16 }, // realistic bge-m3-ish shape, within colbertPool's default 40
      { tokens: 8, docTokens: 3, dim: 8 }, // query longer than doc
    ];
    let seed = 1;
    for (const { tokens, docTokens, dim } of cases) {
      const query = fixtureMatrix(seed++, tokens, dim);
      const doc = fixtureMatrix(seed++, docTokens, dim);
      expect(maxSim(query, doc)).toBeCloseTo(maxSimPairwiseReference(query, doc), 5);
    }
  });

  it("maxSim falls back correctly for a ragged (non-rectangular) doc matrix", () => {
    const query = [
      [1, 0, 0],
      [0, 1, 0],
    ];
    const doc = [
      [1, 0, 0],
      [0, 1], // shorter row -> not rectangular, cosineBatch's single-dim contract can't express it
    ];
    expect(maxSim(query, doc)).toBeCloseTo(maxSimPairwiseReference(query, doc), 10);
  });
});
