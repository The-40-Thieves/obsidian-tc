// THE-391 — binary-relevance nDCG@10 in the eval metrics (the THE-171 roadmap gate metric).
// Position-sensitive where recall@10 is not: the same hit set scores higher ranked earlier.
import { describe, expect, it } from "vitest";
import { computeQueryMetrics, type GoldenQuery, type RankedChunk } from "../eval/metrics";

const q: GoldenQuery = {
  id: "ndcg-fixture",
  query_text: "q",
  seed_domain: "a",
  target_domain: "b",
  seed_paths: ["A.md"],
  target_paths: ["B.md"],
  bridge_paths: [],
  description: "ndcg fixture",
};

const hit = (path: string, i: number): RankedChunk => ({ chunk_id: `c${i}`, path });

describe("THE-391 nDCG@10", () => {
  it("is 1.0 when all expected paths lead the ranking", () => {
    const m = computeQueryMetrics(q, [hit("A.md", 0), hit("B.md", 1), hit("X.md", 2)]);
    expect(m.ndcg_at_10).toBeCloseTo(1.0);
  });

  it("discounts by position: the same hits ranked later score lower", () => {
    const early = computeQueryMetrics(q, [hit("A.md", 0), hit("B.md", 1)]);
    const late = computeQueryMetrics(q, [
      hit("X.md", 0),
      hit("Y.md", 1),
      hit("A.md", 2),
      hit("B.md", 3),
    ]);
    expect(late.recall_at_10).toBeCloseTo(early.recall_at_10); // recall is position-blind
    expect(late.ndcg_at_10).toBeLessThan(early.ndcg_at_10); // nDCG is not
    // rank 3+4 vs ideal rank 1+2: (1/log2(4) + 1/log2(5)) / (1 + 1/log2(3))
    expect(late.ndcg_at_10).toBeCloseTo(
      (1 / Math.log2(4) + 1 / Math.log2(5)) / (1 + 1 / Math.log2(3)),
    );
  });

  it("is 0 with no expected path in the top-10", () => {
    const m = computeQueryMetrics(q, [hit("X.md", 0), hit("Y.md", 1)]);
    expect(m.ndcg_at_10).toBe(0);
  });
});

describe("THE-440 bridge-doc nDCG@10 (static-vs-trajectory proxy)", () => {
  const qb: GoldenQuery = { ...q, bridge_paths: ["BR.md"] };

  it("is null when the query declares no bridge_paths", () => {
    const m = computeQueryMetrics(q, [hit("A.md", 0), hit("B.md", 1)]);
    expect(m.bridge_ndcg_at_10).toBeNull();
  });

  it("scores the bridge doc independently of static relevance", () => {
    // static hits A,B lead; the bridge doc sits at rank 3. Static nDCG stays high;
    // bridge nDCG reflects the bridge doc's discounted position only.
    const m = computeQueryMetrics(qb, [hit("A.md", 0), hit("B.md", 1), hit("BR.md", 2)]);
    expect(m.ndcg_at_10).toBeGreaterThan(0.8); // static axis: A,B up front
    expect(m.bridge_ndcg_at_10).toBeCloseTo(1 / Math.log2(4)); // bridge at rank 3, ideal rank 1
  });

  it("is 0 when the bridge doc is absent while the static docs still rank well", () => {
    const m = computeQueryMetrics(qb, [hit("A.md", 0), hit("B.md", 1)]);
    expect(m.ndcg_at_10).toBeGreaterThan(0.7); // static axis still strong (A,B up front)
    expect(m.bridge_ndcg_at_10).toBe(0); // trajectory axis fails while static axis passes
  });
});
