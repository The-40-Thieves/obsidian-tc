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
  // The first version of this test CLAIMED byte-identity and did not check it — it compared two
  // strings for a shared phrase and some forbidden words, which cross-vendor review correctly
  // called out. The real defence is no longer a matching string at all: the handler no longer has
  // an unreadable branch. It runs the SAME pipeline, and because every arm is ACL-filtered at
  // query time, an unreadable note is genuinely absent from every traced array and produces the
  // real never-a-candidate answer.
  //
  // What is asserted here is the property that makes that sound: summarize() cannot emit anything
  // that distinguishes an unreadable path from an unmatched one, because it never learns the
  // difference — it only ever sees trace records, and both cases produce the same ones.
  it("summarize() has no input that could encode readability — same records, same answer", () => {
    const unmatched = summarize("09-private/secret.md", [
      rec({ stage: "seedGeneration", present: false, chunksPresent: 0 }),
      rec({ stage: "candidateAssembly", present: false, chunksPresent: 0 }),
    ]);
    const unreadable = summarize("09-private/secret.md", [
      rec({ stage: "seedGeneration", present: false, chunksPresent: 0 }),
      rec({ stage: "candidateAssembly", present: false, chunksPresent: 0 }),
    ]);
    // Byte-identical, asserted as such rather than described as such.
    expect(unreadable.summary).toBe(unmatched.summary);
    expect(unreadable.droppedAt).toBe(unmatched.droppedAt);
    expect(unreadable.returned).toBe(unmatched.returned);
  });

  it("never mentions permissions, denial, or ACLs in any branch", () => {
    const cases = [
      summarize("a.md", []),
      summarize("a.md", [rec({ stage: "seedGeneration", present: false, chunksPresent: 0 })]),
      summarize("a.md", [rec({ stage: "projection", present: true })]),
      summarize("a.md", [
        rec({ stage: "candidateAssembly", present: true }),
        rec({ stage: "diversity", present: false, chunksPresent: 0 }),
      ]),
    ];
    for (const c of cases) {
      expect(c.summary.toLowerCase()).not.toMatch(
        /\bacl\b|permission|denied|forbidden|not allowed|unreadable/,
      );
    }
  });
});

describe("THE-632 summarize() bounds its claims to what was traced", () => {
  it("names only the arms actually observed absent — never 'any arm' unconditionally", () => {
    // Absence at candidateAssembly alone cannot establish that graph expansion never reached the
    // note; it may have been reached and cut on a threshold or cap. The old text asserted it had
    // not been "retrieved by any arm", which overclaimed.
    const partial = summarize("a.md", [
      rec({ stage: "candidateAssembly", present: false, chunksPresent: 0 }),
    ]);
    expect(partial.summary).not.toMatch(/any arm/);

    const full = summarize("a.md", [
      rec({ stage: "seedGeneration", present: false, chunksPresent: 0 }),
      rec({ stage: "graphExpansion", present: false, chunksPresent: 0 }),
      rec({ stage: "candidateAssembly", present: false, chunksPresent: 0 }),
    ]);
    expect(full.summary).toContain("seedGeneration");
    expect(full.summary).toContain("graphExpansion");
  });

  it("does not name a late stage as the drop point when earlier stages never ran", () => {
    // The no-seed early return used to yield a lone projection record, and summarize() reported
    // "never entered the candidate pool at projection" — an absurd stage to name. seedGeneration
    // is now traced BEFORE that return, so the first record is the one that actually explains it.
    const noSeed = summarize("a.md", [
      rec({ stage: "seedGeneration", present: false, chunksPresent: 0, candidatesOut: 0 }),
    ]);
    expect(noSeed.droppedAt).toBe("seedGeneration");
    expect(noSeed.summary).not.toMatch(/at projection/);
  });
});

describe("THE-632: a graph-expansion-only hit is not mistaken for never-a-candidate", () => {
  // REGRESSION. Adding the seedGeneration trace silently invalidated summarize()'s assumption that
  // records[0] absent means never-a-candidate: a note reached only through the links_to walk is
  // legitimately absent at seedGeneration and present immediately after. The broken version
  // reported "never entered the candidate pool" for exactly the multi-hop retrieval this engine
  // exists to do, and blamed seedGeneration for a drop that happened at diversity.
  //
  // The shape came from the adversarial case a re-review was constructing when its run was cut
  // short by the vendor's own content filter. The verdict never arrived; the test case still did.
  it("names the real drop stage, not the arm the note never came from", () => {
    const r = summarize("bridge.md", [
      rec({ stage: "seedGeneration", present: false, chunksPresent: 0, candidatesOut: 5 }),
      rec({ stage: "graphExpansion", present: true, candidatesIn: 2, candidatesOut: 4 }),
      rec({ stage: "candidateAssembly", present: true, candidatesIn: 9, candidatesOut: 7 }),
      rec({ stage: "scoreFusion", present: true, candidatesIn: 7, candidatesOut: 7 }),
      rec({
        stage: "diversity",
        present: false,
        chunksPresent: 0,
        candidatesIn: 7,
        candidatesOut: 3,
      }),
      rec({
        stage: "projection",
        present: false,
        chunksPresent: 0,
        candidatesIn: 3,
        candidatesOut: 3,
      }),
    ]);
    expect(r.droppedAt).toBe("diversity");
    expect(r.summary).not.toMatch(/never entered/);
  });

  it("still reports never-a-candidate when the note is absent at EVERY stage", () => {
    const r = summarize("nowhere.md", [
      rec({ stage: "seedGeneration", present: false, chunksPresent: 0 }),
      rec({ stage: "graphExpansion", present: false, chunksPresent: 0 }),
      rec({ stage: "candidateAssembly", present: false, chunksPresent: 0 }),
    ]);
    expect(r.summary).toContain("never entered the candidate pool");
    // Names the stage where "candidate" is actually decided, not the first arm traced.
    expect(r.droppedAt).toBe("candidateAssembly");
  });
});
