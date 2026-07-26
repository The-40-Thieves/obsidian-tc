// THE-388 — ColBERT late-interaction (maxSim) scorer + reranker. Pure functions, hand-built token
// matrices; the bge-m3 encoder that produces the matrices is separate and infra-gated.
import { describe, expect, it } from "vitest";
import { type ColbertMatrix, colbertRerank, maxSim } from "../src/search/colbert";
import { jsCosineSimilarity } from "../src/search/native";

/** The pre-THE-418 `maxSim`: sum over query tokens of the max cosine to any doc token, one call
 *  per (query-token, doc-token) pair, no batching. Delegates to the REAL `jsCosineSimilarity`
 *  (native.ts) rather than reimplementing its cosine formula, so this reference cannot drift from
 *  that function's length/zero-vector contract (`a.length !== b.length || a.length === 0 -> 0`)
 *  independently of the production code being pinned against it — a hand-rolled reimplementation
 *  of that guard is exactly the kind of comment-that-outlives-the-code this test exists to avoid. */
function maxSimPairwiseReference(query: ColbertMatrix, doc: ColbertMatrix): number {
  if (query.length === 0 || doc.length === 0) return 0;
  let total = 0;
  for (const q of query) {
    let best = Number.NEGATIVE_INFINITY;
    for (const d of doc) {
      const s = jsCosineSimilarity(q, d);
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
  // (`maxSimPairwiseReference` above — delegates to the real jsCosineSimilarity, so it cannot
  // drift from that function's contract) on realistic multi-token, multi-dimension fixtures.
  // `toBeCloseTo` (not `toBe`) because the batched path round-trips each query token through a
  // Float32Array — matching semantic.ts's existing native-boundary precedent — so results agree
  // within float tolerance, not bit-for-bit.
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

  // THE-418: this is the ONE behavior the batched rewrite actually introduces relative to the
  // pre-THE-418 loop — maxSim now decides per QUERY TOKEN, once, whether q.length equals the doc's
  // uniform dim (skipping cosineBatch entirely when it doesn't), instead of jsCosineSimilarity's
  // own per-(query-token, doc-token) length check firing inside the innermost loop. The two are
  // equivalent only because every doc row shares one width in the rectangular case (see
  // flattenRectangular in colbert.ts) — worth a dedicated fixture rather than relying on the
  // rectangular-fixtures test above to happen to exercise a width mismatch.
  it("maxSim matches the reference when a query token's width differs from the doc's (doc stays rectangular)", () => {
    const doc = fixtureMatrix(200, 5, 6); // rectangular doc, dim 6
    const query: ColbertMatrix = [
      fixtureMatrix(201, 1, 6)[0] as number[], // matches the doc's width
      fixtureMatrix(202, 1, 3)[0] as number[], // narrower than the doc's width
      fixtureMatrix(203, 1, 9)[0] as number[], // wider than the doc's width
    ];
    // precision 5, not 10: the matching-width token still crosses the batched (Float32Array)
    // path above, which carries the same float-tolerance-not-bit-identical caveat as the
    // rectangular-fixtures test.
    expect(maxSim(query, doc)).toBeCloseTo(maxSimPairwiseReference(query, doc), 5);
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
