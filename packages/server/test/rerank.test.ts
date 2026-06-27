import { describe, expect, it } from "vitest";
import { type Reranker, rerankWithScores } from "../src/search/rerank";

const docs = [{ content: "alpha" }, { content: "beta" }, { content: "gamma" }];

describe("rerank seam (D1) with graceful no-op fallback", () => {
  it("falls back to input order with synthetic descending scores when no reranker", async () => {
    const out = await rerankWithScores("q", docs, 3, null);
    expect(out.map((o) => o.item.content)).toEqual(["alpha", "beta", "gamma"]);
    expect(out[0]?.score).toBeCloseTo(1.0);
    expect(out[1]?.score).toBeCloseTo(0.99);
  });

  it("uses an injected reranker (e.g. the gateway /rerank passthrough)", async () => {
    // Mock reranker reverses relevance: last doc most relevant.
    const reranker: Reranker = async (_q, documents, topN) =>
      documents
        .map((_d, index) => ({ index, relevanceScore: index / 10 }))
        .sort((a, b) => b.relevanceScore - a.relevanceScore)
        .slice(0, topN);
    const out = await rerankWithScores("q", docs, 3, reranker);
    expect(out.map((o) => o.item.content)).toEqual(["gamma", "beta", "alpha"]);
    expect(out[0]?.score).toBeCloseTo(0.2);
  });

  it("degrades to pre-rerank order when the reranker throws (gateway unreachable)", async () => {
    const throwing: Reranker = async () => {
      throw new Error("gateway unreachable");
    };
    const out = await rerankWithScores("q", docs, 3, throwing);
    expect(out.map((o) => o.item.content)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("returns empty for empty docs", async () => {
    expect(await rerankWithScores("q", [], 3, null)).toEqual([]);
  });
});
