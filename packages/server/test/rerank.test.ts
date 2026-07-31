import { describe, expect, it } from "vitest";
import { type Reranker, type RerankOutcome, rerankWithScores } from "../src/search/rerank";

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

// rerankWithScores' fallback is byte-identical for every degraded path above — the whole
// point of this ticket is that WHY it fired was previously unobservable. `onOutcome` closes that
// gap without touching the return shape or the fallback scores (re-asserted per outcome below).
describe("RerankOutcome distinguishes every degraded path from a genuine success", () => {
  function capture(): { outcomes: RerankOutcome[]; onOutcome: (o: RerankOutcome) => void } {
    const outcomes: RerankOutcome[] = [];
    return { outcomes, onOutcome: (o) => outcomes.push(o) };
  }

  it("the crux: not_configured is distinguishable from executed", async () => {
    const { outcomes, onOutcome } = capture();
    const workingReranker: Reranker = async (_q, documents, topN) =>
      documents.map((_d, index) => ({ index, relevanceScore: 1 - index * 0.1 })).slice(0, topN);

    await rerankWithScores("q", docs, 3, null, onOutcome);
    await rerankWithScores("q", docs, 3, workingReranker, onOutcome);

    expect(outcomes).toEqual(["not_configured", "executed"]);
    expect(outcomes[0]).not.toBe(outcomes[1]);
  });

  it("provider_error: a throwing reranker is reported distinctly, and the caller still gets the fallback ranking", async () => {
    const { outcomes, onOutcome } = capture();
    const throwing: Reranker = async () => {
      throw new Error("gateway unreachable");
    };
    const out = await rerankWithScores("q", docs, 3, throwing, onOutcome);

    expect(outcomes).toEqual(["provider_error"]);
    // Fallback ranking unchanged from the pre-change behavior asserted above.
    expect(out.map((o) => o.item.content)).toEqual(["alpha", "beta", "gamma"]);
    expect(out[0]?.score).toBeCloseTo(1.0);
  });

  it("timed_out: a reranker that never settles within timeoutMs is reported distinctly from provider_error, and still falls back", async () => {
    const { outcomes, onOutcome } = capture();
    const hangs: Reranker = () => new Promise(() => {}); // never resolves or rejects
    const out = await rerankWithScores("q", docs, 3, hangs, onOutcome, 10);

    expect(outcomes).toEqual(["timed_out"]);
    expect(out.map((o) => o.item.content)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("malformed_response (non-empty docs, unusable hits) is distinguished from a successful empty (zero docs)", async () => {
    const { outcomes, onOutcome } = capture();
    // A "successful empty": a reranker IS configured, but there is nothing to rank — not a
    // failure. (An absent reranker on empty docs would report "not_configured" instead, since
    // that check runs first; this isolates the empty-input case specifically.)
    const configuredReranker: Reranker = async () => [];
    const emptyOut = await rerankWithScores("q", [], 3, configuredReranker, onOutcome);
    expect(emptyOut).toEqual([]);
    expect(outcomes).toEqual(["fallback_used"]);

    // Malformed: docs are non-empty but the reranker answers with nothing usable (indices out of
    // range) — a working call has no legitimate reason to say nothing about a non-empty input.
    const malformed: Reranker = async () => [{ index: 99, relevanceScore: 1 }];
    const out = await rerankWithScores("q", docs, 3, malformed, onOutcome);
    expect(outcomes).toEqual(["fallback_used", "malformed_response"]);
    // Still the same fallback ranking as every other degraded path.
    expect(out.map((o) => o.item.content)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("a throwing onOutcome sink cannot mask the real result or break retrieval", async () => {
    const workingReranker: Reranker = async (_q, documents, topN) =>
      documents.map((_d, index) => ({ index, relevanceScore: 1 - index * 0.1 })).slice(0, topN);
    const throwingSink = (): void => {
      throw new Error("sink exploded");
    };

    // A genuine success: the sink throwing must not turn this into a fallback or an unhandled
    // rejection propagating out of rerankWithScores.
    const out = await rerankWithScores("q", docs, 3, workingReranker, throwingSink);
    expect(out.map((o) => o.item.content)).toEqual(["alpha", "beta", "gamma"]);

    // A genuine failure: the sink throwing must not swallow/replace the fallback that a real
    // provider error already produced.
    const throwingReranker: Reranker = async () => {
      throw new Error("gateway unreachable");
    };
    const fallback = await rerankWithScores("q", docs, 3, throwingReranker, throwingSink);
    expect(fallback.map((o) => o.item.content)).toEqual(["alpha", "beta", "gamma"]);
  });
});
