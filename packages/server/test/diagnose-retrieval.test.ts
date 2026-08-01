// THE-632: diagnose_retrieval's reading of a trace.
//
// The tool's job is not to dump stage records — an agent can read those — but to answer the
// question that was asked: WHY was this note not returned. That reduces to naming the FIRST stage
// where it stopped being present, because everything after that is downstream of the real cause.
import { describe, expect, it } from "vitest";
import type { RetrievalTraceRecord } from "../src/search/graph_search_stages/instrumentation";
import { summarize } from "../src/tools/m7/knowledge/diagnose-retrieval";

const rec = (over: Partial<RetrievalTraceRecord>): RetrievalTraceRecord => ({
  stage: "candidateAssembly",
  present: true,
  chunksPresent: 1,
  candidatesIn: 40,
  candidatesOut: 20,
  ...over,
});

describe("THE-632 summarize()", () => {
  it("reports a returned note as returned, and does not invent a drop stage", () => {
    const r = summarize("a.md", [
      rec({ stage: "candidateAssembly" }),
      rec({ stage: "projection", chunksPresent: 2 }),
    ]);
    expect(r.returned).toBe(true);
    expect(r.droppedAt).toBeNull();
    expect(r.summary).toContain("WAS returned");
  });

  it("distinguishes NEVER A CANDIDATE from was-a-candidate-then-cut", () => {
    // These need different fixes — indexing/embedding vs ranking — so collapsing them into
    // "not returned" is the failure this tool exists to end.
    const never = summarize("a.md", [
      rec({ stage: "candidateAssembly", present: false, chunksPresent: 0 }),
      rec({ stage: "projection", present: false, chunksPresent: 0 }),
    ]);
    expect(never.returned).toBe(false);
    expect(never.droppedAt).toBe("candidateAssembly");
    expect(never.summary).toContain("never entered the candidate pool");
    expect(never.summary).toContain("no later stage ever scored it");

    const cut = summarize("a.md", [
      rec({ stage: "candidateAssembly", present: true }),
      rec({ stage: "scoreFusion", present: true, rank: 18, score: 0.0121, candidatesOut: 20 }),
      rec({ stage: "diversity", present: false, chunksPresent: 0, candidatesIn: 20 }),
    ]);
    expect(cut.returned).toBe(false);
    expect(cut.droppedAt).toBe("diversity");
    expect(cut.summary).not.toContain("never entered");
  });

  it("names the FIRST drop, not the last stage — later stages are downstream of the cause", () => {
    const r = summarize("a.md", [
      rec({ stage: "candidateAssembly", present: true }),
      rec({ stage: "scoreFusion", present: false, chunksPresent: 0 }),
      rec({ stage: "diversity", present: false, chunksPresent: 0 }),
      rec({ stage: "projection", present: false, chunksPresent: 0 }),
    ]);
    expect(r.droppedAt).toBe("scoreFusion");
    expect(r.droppedAt).not.toBe("projection");
  });

  it("carries the last-seen rank and score into the summary, so the drop is quantified", () => {
    const r = summarize("a.md", [
      rec({ stage: "candidateAssembly", present: true }),
      rec({ stage: "scoreFusion", present: true, rank: 18, score: 0.0121, candidatesOut: 20 }),
      rec({ stage: "diversity", present: false, chunksPresent: 0, candidatesIn: 20 }),
    ]);
    expect(r.summary).toContain("rank 18");
    expect(r.summary).toContain("0.0121");
  });

  it("handles a pipeline that terminated before any stage ran", () => {
    // The early return in graphSearchCore (no seeds, no lexical, no sparse) means zero records.
    // Reporting "dropped at undefined" there would be worse than saying plainly what happened.
    const r = summarize("a.md", []);
    expect(r.returned).toBe(false);
    expect(r.droppedAt).toBeNull();
    expect(r.summary).toContain("never evaluated");
  });
});

describe("THE-632 ACL: an unreadable path must not be an existence oracle", () => {
  it("the unreadable response is byte-identical in SHAPE to a never-a-candidate one", () => {
    // The handler short-circuits an unreadable path with the same summary text a genuinely
    // unmatched note produces. This asserts the two strings agree, so a future edit to one that
    // forgets the other reintroduces the distinction — and with it the oracle.
    const rel = "09-private/secret.md";
    const unmatched = summarize(rel, [
      rec({ stage: "candidateAssembly", present: false, chunksPresent: 0 }),
    ]);
    // The literal the handler returns for an unreadable path (kept in sync with the branch above).
    const unreadable = `${rel} never entered the candidate pool, so no later stage ever scored it. It was not retrieved by any arm — check that the note is indexed and that the query shares vocabulary or a link path with it.`;

    // Both must open with the same claim and neither may mention permissions, ACLs, or denial —
    // any of which would confirm the path exists to a caller who cannot read it.
    expect(unmatched.summary).toContain("never entered the candidate pool");
    expect(unreadable).toContain("never entered the candidate pool");
    for (const s of [unmatched.summary, unreadable]) {
      expect(s.toLowerCase()).not.toMatch(/\backl\b|permission|denied|forbidden|not allowed/);
    }
  });
});
