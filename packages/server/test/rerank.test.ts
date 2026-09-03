import { describe, expect, it } from "vitest";
import { compileEgressFilter, EgressViolationError } from "../src/plane/egress-filter";
import { type Reranker, type RerankOutcome, rerankWithScores } from "../src/search/rerank";

const docs = [
  { content: "alpha", path: "A.md" },
  { content: "beta", path: "B.md" },
  { content: "gamma", path: "C.md" },
];

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

// THE-934 fix round 2 (N4) — round 1 merged the reranked set and the excluded-but-demoted set by
// SCORE comparison, and a synthetic fusion-order score (1.0 decaying by 0.01) sits on a totally
// different scale from a real cross-encoder relevance score, so an excluded doc near the head of
// the fusion order outranked essentially every reranked doc — enabling exclusion PROMOTED the
// excluded folder to the top of search results, the opposite of the intended effect. Fixed by
// appending excluded docs after the reranked set (fusion order, never re-scored against it) rather
// than merging by score at all — reproduces the reviewer's exact probe.
describe("excluded docs never outrank reranked ones (THE-934 fix round 2, N4)", () => {
  const withExcluded = [
    { content: "PRIVATE ONE", path: "Private/b.md" },
    { content: "PUBLIC TWO", path: "Public/a.md" },
    { content: "PUBLIC THREE", path: "Public/c.md" },
  ];

  it("reviewer's probe: [Private/b.md, Public/a.md, Public/c.md] — the private doc must not outrank the reranked public ones", async () => {
    const seenDocuments: string[][] = [];
    const reranker: Reranker = async (_q, documents) => {
      seenDocuments.push(documents);
      // The reranker scores the two PUBLIC docs it actually saw; index 0 here is whichever
      // survived the exclusion filter first (Public/a.md), index 1 is Public/c.md.
      return [
        { index: 0, relevanceScore: 0.5 },
        { index: 1, relevanceScore: 0.4 },
      ];
    };
    const out = await rerankWithScores(
      "q",
      withExcluded,
      3,
      reranker,
      undefined,
      undefined,
      compileEgressFilter(["Private/**"]),
    );
    // No excluded text ever reached the reranker — asserted on the request PAYLOAD.
    expect(seenDocuments).toEqual([["PUBLIC TWO", "PUBLIC THREE"]]);
    // The private doc is LAST, never ahead of either reranked public doc, regardless of its
    // synthetic fusion-order score (which would be the highest of the three under round 1's
    // score-merge rule — 1.0 vs the reranker's real 0.5/0.4).
    expect(out.map((o) => o.item.path)).toEqual(["Public/a.md", "Public/c.md", "Private/b.md"]);
    expect(out[0]?.score).toBeCloseTo(0.5);
    expect(out[1]?.score).toBeCloseTo(0.4);
    // NB3 (follow-up review): appending fixes the order THIS call returns, but the private doc's
    // SCORE FIELD used to still carry the synthetic fallback (~1.0) — strictly ABOVE both real
    // reranked scores on paper. A later consumer that re-sorts by score (e.g.
    // experiential.activationRerank's bubbleSafeRerank, ships false but reads the field directly)
    // could then promote it purely because its number looked bigger. The private doc's score must
    // sit strictly BELOW the lowest reranked score, not merely after it in this array.
    expect(out[2]?.item.path).toBe("Private/b.md");
    expect(out[2]?.score).toBeLessThan(0.4);
    // Sorting the whole returned array by score (simulating exactly the re-sort NB3 warns about)
    // must not move the private doc off the bottom.
    const resorted = [...out].sort((a, b) => b.score - a.score);
    expect(resorted[resorted.length - 1]?.item.path).toBe("Private/b.md");
  });

  it("every candidate excluded: the fallback (no reranker call) still returns them in fusion order", async () => {
    const allExcluded = [
      { content: "SECRET A", path: "Private/a.md" },
      { content: "SECRET B", path: "Private/b.md" },
    ];
    let called = false;
    const reranker: Reranker = async () => {
      called = true;
      return [];
    };
    const out = await rerankWithScores(
      "q",
      allExcluded,
      2,
      reranker,
      undefined,
      undefined,
      compileEgressFilter(["Private/**"]),
    );
    expect(called).toBe(false);
    expect(out.map((o) => o.item.path)).toEqual(["Private/a.md", "Private/b.md"]);
  });

  it("topN truncation drops trailing excluded docs before promoting them", async () => {
    const mixed = [
      { content: "PRIVATE", path: "Private/z.md" },
      { content: "PUBLIC", path: "Public/a.md" },
    ];
    const reranker: Reranker = async () => [{ index: 0, relevanceScore: 0.9 }];
    const out = await rerankWithScores(
      "q",
      mixed,
      1, // topN=1: only room for the reranked public doc, not the appended excluded one
      reranker,
      undefined,
      undefined,
      compileEgressFilter(["Private/**"]),
    );
    expect(out.map((o) => o.item.path)).toEqual(["Public/a.md"]);
  });

  it("THE-934 fix round 3 (B): an EgressViolationError from the reranker call PROPAGATES, distinct from an ordinary provider_error that falls back", async () => {
    const mixed = [
      { content: "PRIVATE", path: "Private/z.md" },
      { content: "PUBLIC", path: "Public/a.md" },
    ];
    const reranker: Reranker = async () => {
      throw new EgressViolationError("guard fired");
    };
    await expect(
      rerankWithScores(
        "q",
        mixed,
        2,
        reranker,
        undefined,
        undefined,
        compileEgressFilter(["Private/**"]),
      ),
    ).rejects.toBeInstanceOf(EgressViolationError);
  });

  it("THE-934 fix round 3 (B): on a genuine provider_error, the fallback still excludes — it must not fall back over the UNFILTERED original docs", async () => {
    const mixed = [
      { content: "PRIVATE", path: "Private/z.md" },
      { content: "PUBLIC ONE", path: "Public/a.md" },
      { content: "PUBLIC TWO", path: "Public/c.md" },
    ];
    const reranker: Reranker = async () => {
      throw new Error("gateway unreachable");
    };
    const out = await rerankWithScores(
      "q",
      mixed,
      3,
      reranker,
      undefined,
      undefined,
      compileEgressFilter(["Private/**"]),
    );
    // The private doc is present (fusion-order fallback still returns it, never sent anywhere) but
    // strictly last, never reordered ahead of the two public docs by the buggy raw-docs fallback.
    expect(out.map((o) => o.item.path)).toEqual(["Public/a.md", "Public/c.md", "Private/z.md"]);
  });

  it("THE-934 fix round 3 (B): on a malformed_response, the fallback still excludes — same rule as provider_error", async () => {
    const mixed = [
      { content: "PRIVATE", path: "Private/z.md" },
      { content: "PUBLIC ONE", path: "Public/a.md" },
    ];
    const reranker: Reranker = async () => []; // non-empty docs, empty hits -> malformed_response
    const out = await rerankWithScores(
      "q",
      mixed,
      2,
      reranker,
      undefined,
      undefined,
      compileEgressFilter(["Private/**"]),
    );
    expect(out.map((o) => o.item.path)).toEqual(["Public/a.md", "Private/z.md"]);
  });
});
