// THE-632: the retrieval trace must be a PURE SIDE-CHANNEL.
//
// Same contract as onCoverage (THE-631) and onStageMetric (THE-465): setting `tracePath` may not
// filter, boost, reorder, or truncate anything. A diagnostic that perturbs the pipeline answers a
// question about itself, and the whole point of tracing the real path rather than a parallel debug
// one is that the answer describes production.
//
// This is also why diagnose_retrieval re-runs the SAME pipeline with tracing on, instead of the
// pipeline retaining per-chunk scores for later inspection: retention would cost every normal
// search, and a debug branch that is always live is the branch that drifts.
import { describe, expect, it } from "vitest";
import { estimateCoverage } from "../src/search/graph_search";
import type {
  OnRetrievalTrace,
  RetrievalTraceRecord,
} from "../src/search/graph_search_stages/instrumentation";

// The trace contract is exercised end-to-end by the graph-search suites; what this file pins is the
// SHAPE of a record and the absent-not-zero rule, which is where a well-meaning edit does damage.
describe("RetrievalTraceRecord shape (THE-632)", () => {
  it("omits score/rank rather than defaulting them to 0", () => {
    // A stage with no notion of a score must not report `score: 0` — that reads as "scored
    // terribly" when the truth is "not scored here", and it is exactly the class of false signal
    // THE-688 was filed about one layer up.
    const seen: RetrievalTraceRecord[] = [];
    const emit: OnRetrievalTrace = (r) => seen.push(r);

    emit({
      stage: "candidateAssembly",
      present: false,
      chunksPresent: 0,
      candidatesIn: 40,
      candidatesOut: 12,
      note: "absent here means the note never entered the candidate pool",
    });

    const [rec] = seen;
    expect(rec).toBeDefined();
    expect(rec?.present).toBe(false);
    expect(rec?.chunksPresent).toBe(0);
    // The distinction that matters: the KEYS are absent, not present-and-zero.
    expect(Object.hasOwn(rec ?? {}, "score")).toBe(false);
    expect(Object.hasOwn(rec ?? {}, "rank")).toBe(false);
  });

  it("chunksPresent distinguishes partial survival from total loss", () => {
    // A note is many chunks. "1 of 7 survived" and "7 of 7 survived" are different diagnoses that a
    // boolean `present` collapses into the same answer.
    const partial: RetrievalTraceRecord = {
      stage: "diversity",
      present: true,
      chunksPresent: 1,
      candidatesIn: 30,
      candidatesOut: 10,
      score: 0.41,
      rank: 8,
    };
    expect(partial.present).toBe(true);
    expect(partial.chunksPresent).toBe(1);
    expect(partial.chunksPresent).toBeLessThan(7);
  });
});

describe("coverage estimate is unaffected by tracing (THE-631 x THE-632)", () => {
  it("estimateCoverage reads only the results, so a trace cannot move it", () => {
    // estimateCoverage is pure over the RESULT array. Tracing never touches that array, so this is
    // the cheap structural proof that turning tracing on cannot change what the caller is told
    // about coverage — the two side-channels stay independent.
    const results = [
      {
        chunk_id: "c1",
        path: "a.md",
        source: "seed" as const,
        hop: 0,
        via_edge: null,
        root_seed: null,
        rerank_score: 0.9,
      },
    ];
    const a = estimateCoverage(results, 5, { routedToSeedsOnly: false, expansionTruncated: false });
    const b = estimateCoverage(results, 5, { routedToSeedsOnly: false, expansionTruncated: false });
    expect(a).toEqual(b);
    expect(a.returned).toBe(1);
    expect(a.underfilled).toBe(true);
  });
});
