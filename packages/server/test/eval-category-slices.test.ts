// THE-449 remaining criterion: category slices. The taxonomy and reachability halves shipped under
// THE-446 — a backlog audit found the code annotated THE-446, and two independent verifiers agreed.
// What was never delivered is per-category aggregation: metrics are only ever reported over the
// whole set, so "the graph arm regressed" can't be narrowed to "…on temporal queries".
//
// Two sources of category, deliberately:
//   1. An optional `categories` field on a golden query — explicit, author-controlled.
//   2. A DERIVED hop category from seed_domain vs target_domain, so an existing golden set gets
//      useful slicing with zero re-annotation. The real golden set has 136 queries; requiring a
//      manual pass over all of them before any slice worked would have meant this stayed unbuilt.
import { describe, expect, it } from "vitest";
import { categoriesOf, sliceByCategory } from "../eval/categories";
import type { GoldenQuery, QueryMetrics } from "../eval/metrics";

const q = (over: Partial<GoldenQuery> = {}): GoldenQuery => ({
  id: "q1",
  query_text: "x",
  seed_domain: "alpha",
  target_domain: "gamma",
  seed_paths: [],
  target_paths: [],
  bridge_paths: [],
  description: "d",
  ...over,
});

const m = (id: string, ndcg: number): QueryMetrics =>
  ({
    query_id: id,
    recall_at_10: ndcg,
    mrr_at_10: ndcg,
    ndcg_at_10: ndcg,
    bridge_recall: 0,
    bridge_ndcg_at_10: 0,
    declares_bridge: false,
  }) as unknown as QueryMetrics;

describe("THE-449 category derivation", () => {
  it("derives cross-domain when seed and target domains differ", () => {
    expect(categoriesOf(q({ seed_domain: "alpha", target_domain: "gamma" }))).toContain(
      "cross-domain",
    );
  });

  it("derives single-domain when they match", () => {
    const cats = categoriesOf(q({ seed_domain: "beta", target_domain: "beta" }));
    expect(cats).toContain("single-domain");
    expect(cats).not.toContain("cross-domain");
  });

  it("includes explicit categories alongside the derived one", () => {
    const cats = categoriesOf(q({ categories: ["temporal", "lexical"] } as Partial<GoldenQuery>));
    expect(cats).toEqual(expect.arrayContaining(["temporal", "lexical", "cross-domain"]));
  });

  it("is deterministic and deduplicated", () => {
    const cats = categoriesOf(
      q({ categories: ["temporal", "temporal", "cross-domain"] } as Partial<GoldenQuery>),
    );
    expect(cats).toEqual([...new Set(cats)].sort());
  });
});

describe("THE-449 per-category aggregation", () => {
  const queries = [
    q({ id: "a", seed_domain: "x", target_domain: "y" }), // cross-domain
    q({ id: "b", seed_domain: "x", target_domain: "y" }), // cross-domain
    q({ id: "c", seed_domain: "z", target_domain: "z" }), // single-domain
  ];

  it("aggregates each category over only its own queries", () => {
    const slices = sliceByCategory(queries, [m("a", 1), m("b", 0), m("c", 0.5)]);

    expect(slices["cross-domain"]?.query_count).toBe(2);
    expect(slices["cross-domain"]?.mean_ndcg_at_10).toBeCloseTo(0.5);
    expect(slices["single-domain"]?.query_count).toBe(1);
    expect(slices["single-domain"]?.mean_ndcg_at_10).toBeCloseTo(0.5);
  });

  it("a category's denominator is its own count, not the whole set", () => {
    // The bug this guards: dividing a slice's total by the full query count silently deflates
    // every slice, making a real per-category regression look like a small global one.
    const slices = sliceByCategory(queries, [m("a", 1), m("b", 1), m("c", 0)]);

    expect(slices["cross-domain"]?.mean_ndcg_at_10).toBeCloseTo(1);
  });

  it("omits categories with no queries rather than emitting empty slices", () => {
    const slices = sliceByCategory([queries[2] as GoldenQuery], [m("c", 1)]);

    expect(slices["single-domain"]).toBeDefined();
    expect(slices["cross-domain"]).toBeUndefined();
  });

  it("ignores metrics with no matching query instead of miscounting", () => {
    const slices = sliceByCategory([queries[0] as GoldenQuery], [m("a", 1), m("ghost", 0)]);

    expect(slices["cross-domain"]?.query_count).toBe(1);
  });
});
