// THE-651 — the decomposer's pure halves, and the router class that gates it.
//
// The conditioning is the mechanism under test: THE-448 measured UNCONDITIONAL fan-out at
// −0.047 nDCG@10 (p=0.0004), so what has to be pinned here is not "decomposition works" — the A/B
// decides that — but the three properties that make the A/B a valid contrast at all:
//
//   1. the multi_hop class claims ONLY queries that would otherwise be `standard`
//   2. a single list fuses to itself, so the single-hop path is byte-identical rather than similar
//   3. a failed decomposition degrades to the original query rather than to a hole
import { describe, expect, it } from "vitest";
import { fuseRanked, MAX_SUB_QUESTIONS, parseSubQuestions } from "../src/search/decompose";
import { multiHopSignals } from "../src/search/router";

describe("multiHopSignals — the conditioning", () => {
  it("fires on relational phrasing", () => {
    for (const q of [
      "How does the graphify deep dive inform the converged memory engine architecture",
      "What connections exist between my health system and endurance themes",
      "how does Dr. Islam relate to my AGI timeline analysis",
      "compare the Rochester build-vs-buy decision to the 1776 site",
    ]) {
      expect(multiHopSignals(q), q).not.toEqual([]);
    }
  });

  it("stays silent on single-hop phrasing", () => {
    // These link two domains in the CORPUS but are asked as one question. That distinction is the
    // whole ticket: `bridge_paths` is a property of the corpus, not of the query.
    for (const q of [
      "What is the full release strategy and marketing plan for The 13th Letter?",
      "Which model research backs my four-model AI stack decisions?",
      "Where do the individual cultures of my fantasy world get tracked?",
    ]) {
      expect(multiHopSignals(q), q).toEqual([]);
    }
  });

  it("reports WHICH marker fired, so a route is auditable", () => {
    expect(multiHopSignals("how does X relate to Y")[0]).toBe("multi-hop:relate to");
    expect(multiHopSignals("how X relates to Y")[0]).toBe("multi-hop:relates to");
  });
});

describe("parseSubQuestions", () => {
  it("strips numbering and bullets", () => {
    const out = parseSubQuestions("1. What is X?\n- What is Y?\n• How do they connect?", "orig");
    expect(out).toEqual(["What is X?", "What is Y?", "How do they connect?"]);
  });

  it("caps at MAX_SUB_QUESTIONS — an uncapped decomposer is N retrievals", () => {
    const many = Array.from({ length: 9 }, (_, i) => `Q${i}?`).join("\n");
    expect(parseSubQuestions(many, "orig")).toHaveLength(MAX_SUB_QUESTIONS);
  });

  it("dedupes case-insensitively so one sub-question cannot be double-weighted", () => {
    // A repeat would contribute twice to the RRF sum, which reads as a ranking effect and is not.
    expect(parseSubQuestions("What is X?\nwhat is x?\nWhat is Y?", "orig")).toEqual([
      "What is X?",
      "What is Y?",
    ]);
  });

  it("falls back to the ORIGINAL on empty or unusable output, never to nothing", () => {
    // Returning [] would remove the query from the result set entirely and show up in the A/B as a
    // ranking loss rather than as a decomposition failure.
    expect(parseSubQuestions("", "orig")).toEqual(["orig"]);
    expect(parseSubQuestions("\n\n   \n", "orig")).toEqual(["orig"]);
  });
});

describe("fuseRanked — same unit as the control", () => {
  it("returns a single list UNCHANGED, which is what makes single-hop byte-identical", () => {
    // The pre-registered flat-slice condition depends on this exactly: not "similar order", the
    // same array. If fusion re-sorted a one-element input, every single-hop query would drift and
    // the conditional premise would be void.
    const one = [{ id: "c" }, { id: "a" }, { id: "b" }];
    expect(fuseRanked([one], (x) => x.id)).toEqual(one);
  });

  it("ranks an item appearing in several lists above one appearing in a single list", () => {
    const l1 = [{ id: "a" }, { id: "b" }];
    const l2 = [{ id: "c" }, { id: "a" }];
    expect(fuseRanked([l1, l2], (x) => x.id).map((x) => x.id)[0]).toBe("a");
  });

  it("dedupes across lists — the merged pool is chunks, not chunk-occurrences", () => {
    const l1 = [{ id: "a" }];
    const l2 = [{ id: "a" }];
    expect(fuseRanked([l1, l2], (x) => x.id)).toHaveLength(1);
  });
});
