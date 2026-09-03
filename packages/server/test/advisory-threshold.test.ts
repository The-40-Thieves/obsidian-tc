// THE-634 — the interrupt threshold, which the ticket names as the part that decides whether
// proactive surfacing is any good:
//
//   "A proactive system that is wrong 30% of the time is worse than no proactive system, because
//    users learn to dismiss it and then miss the 70%."
//
// So these tests pin the four stated requirements as invariants rather than as behaviours that
// happen to hold today: precision over recall, never a digest, a hard rate limit that decays on
// dismissal, and dismissals counted as signal.
//
// COVERAGE BOUNDARY, stated so it is not mistaken for more: nothing here exercises DELIVERY. There
// is no delivery path — the only unsolicited channel is `subscriptions/listen` (2026-07-28 only)
// and production sits behind a 2025-11-25 gateway. The engine is tested; the transport does not
// exist and is not stubbed, because a stub would assert a shape nobody has agreed to.
import { describe, expect, it } from "vitest";
import type { AdvisoryCandidate, AdvisoryGoal, ScoredAdvisory } from "../src/experiential/advisory";
import { scoreAgainstGoals } from "../src/experiential/advisory";
import type { AdvisoryPolicy, AdvisorySessionState } from "../src/experiential/advisory-policy";
import {
  applyFeedback,
  recordEmission,
  remainingBudget,
  selectAdvisories,
} from "../src/experiential/advisory-policy";

const POLICY: AdvisoryPolicy = { minScore: 0.6, topK: 2, maxPerSession: 3, dismissalPenalty: 1 };
const FRESH: AdvisorySessionState = { emitted: 0, dismissed: 0, seenRefs: new Set() };

/** Three fields, not a store row. `scoreAgainstGoals` takes `AdvisoryGoal` structurally so it never
 *  imports the goals store — see the type's own docblock and goals.test.ts constraint 3. */
function goal(id: string, text: string, status = "open"): AdvisoryGoal {
  return { id, text, status };
}

function cand(ref: string, text: string, at = 100): AdvisoryCandidate {
  return { kind: "note_changed", ref, path: `${ref}.md`, text, at };
}

/** A scored item straight into the policy layer, bypassing similarity. */
function scored(ref: string, score: number, at = 100): ScoredAdvisory {
  return { goalId: "g1", goalText: "goal", candidate: cand(ref, ref, at), score };
}

describe("scoreAgainstGoals", () => {
  it("scores against OPEN goals only — a closed goal cannot pull an advisory", () => {
    // Relevance to an abandoned goal is relevance to nothing. listGoals defaults to open, but a
    // caller passing status:"any" must not accidentally resurrect one.
    const goals = [goal("g1", "ship the parser", "abandoned")];
    expect(scoreAgainstGoals(goals, [cand("a.md", "parser work")], () => 0.99)).toEqual([]);
  });

  it("emits ONE pair per candidate — the best goal, not every goal it touches", () => {
    // The digest trap arriving sideways: a note relevant to three goals is still one thing to
    // mention. Three rows would let a topK of 2 be filled entirely by the same note.
    const goals = [goal("g1", "alpha"), goal("g2", "beta"), goal("g3", "gamma")];
    const sim = (g: string) => (g === "beta" ? 0.9 : 0.5);
    const out = scoreAgainstGoals(goals, [cand("a.md", "x")], sim);
    expect(out).toHaveLength(1);
    expect(out[0]?.goalId).toBe("g2");
  });

  it("returns nothing when there are no open goals — proactivity needs an anchor", () => {
    // "Relevance to the last query is not proactivity, it is caching."
    expect(scoreAgainstGoals([], [cand("a.md", "x")], () => 1)).toEqual([]);
  });

  it("ranks by score, breaking ties by recency", () => {
    const goals = [goal("g1", "g")];
    const sim = (_g: string, c: string) => (c === "low" ? 0.2 : 0.8);
    const out = scoreAgainstGoals(
      goals,
      [cand("old.md", "high", 10), cand("low.md", "low", 999), cand("new.md", "high", 50)],
      sim,
    );
    expect(out.map((a) => a.candidate.ref)).toEqual(["new.md", "old.md", "low.md"]);
  });

  it("skips a non-finite similarity rather than ranking NaN", () => {
    // NaN comparisons are always false, so an unguarded NaN silently wins or loses depending on
    // iteration order — a bug that would look like flakiness.
    const goals = [goal("g1", "g")];
    const out = scoreAgainstGoals(goals, [cand("a.md", "x")], () => Number.NaN);
    expect(out).toEqual([]);
  });
});

describe("selectAdvisories — never a digest", () => {
  it("caps at topK no matter how many clear the floor", () => {
    // THE invariant. Ten strong candidates must still yield two.
    const many = Array.from({ length: 10 }, (_, i) => scored(`n${i}.md`, 0.95));
    expect(selectAdvisories(many, POLICY, FRESH)).toHaveLength(2);
  });

  it("filters BEFORE capping, so a low scorer never occupies a slot", () => {
    // Capping first would take [junk, good] and emit junk. Filtering first takes the two that
    // qualify. The input is ranked, so this is about the ORDER of the two operations, not sorting.
    const ranked = [scored("junk.md", 0.1), scored("a.md", 0.9), scored("b.md", 0.8)];
    expect(selectAdvisories(ranked, POLICY, FRESH).map((a) => a.candidate.ref)).toEqual([
      "a.md",
      "b.md",
    ]);
  });

  it("drops anything already surfaced this session", () => {
    const state = { ...FRESH, seenRefs: new Set(["a.md"]) };
    const ranked = [scored("a.md", 0.99), scored("b.md", 0.7)];
    expect(selectAdvisories(ranked, POLICY, state).map((a) => a.candidate.ref)).toEqual(["b.md"]);
  });

  it("emits nothing when every candidate is below the floor", () => {
    // Silence is a valid output. A "best available" fallback is exactly how a channel becomes noise.
    const ranked = [scored("a.md", 0.59), scored("b.md", 0.4)];
    expect(selectAdvisories(ranked, POLICY, FRESH)).toEqual([]);
  });
});

describe("the rate limit decays on dismissal", () => {
  it("spends budget as advisories are emitted", () => {
    expect(remainingBudget(POLICY, FRESH)).toBe(3);
    expect(remainingBudget(POLICY, { ...FRESH, emitted: 2 })).toBe(1);
  });

  it("three dismissals exhaust a budget of three, and it floors at zero", () => {
    expect(remainingBudget(POLICY, { ...FRESH, dismissed: 3 })).toBe(0);
    // Not negative — a fourth dismissal must not create debt that outlives the session.
    expect(remainingBudget(POLICY, { ...FRESH, dismissed: 9 })).toBe(0);
  });

  it("an exhausted budget emits nothing even for a perfect match", () => {
    const spent = { ...FRESH, dismissed: 3 };
    expect(selectAdvisories([scored("a.md", 1.0)], POLICY, spent)).toEqual([]);
  });

  it("the budget beats topK when only one slot is left", () => {
    // topK 2 but budget 1 must yield 1. The hard rate limit wins over everything.
    const almost = { ...FRESH, emitted: 2 };
    expect(
      selectAdvisories([scored("a.md", 0.9), scored("b.md", 0.9)], POLICY, almost),
    ).toHaveLength(1);
  });
});

describe("feedback is signal, and only -1 costs budget", () => {
  it("counts a -1 as a dismissal", () => {
    expect(applyFeedback(FRESH, -1).dismissed).toBe(1);
  });

  it("does NOT count 0 or +1 — silence must not be expensive", () => {
    // 0 is "seen, no opinion" and is the common case; +1 is the channel working. Charging either
    // against the budget would shut down a channel that is succeeding.
    expect(applyFeedback(FRESH, 0).dismissed).toBe(0);
    expect(applyFeedback(FRESH, 1).dismissed).toBe(0);
  });
});

describe("recordEmission closes the loop", () => {
  it("advances the count and the repeat-guard together", () => {
    const next = recordEmission(FRESH, [scored("a.md", 0.9), scored("b.md", 0.8)]);
    expect(next.emitted).toBe(2);
    expect([...next.seenRefs].sort()).toEqual(["a.md", "b.md"]);
  });

  it("is a no-op on an empty emission, and never mutates the input", () => {
    expect(recordEmission(FRESH, [])).toBe(FRESH);
    const next = recordEmission(FRESH, [scored("a.md", 0.9)]);
    expect(FRESH.seenRefs.size).toBe(0);
    expect(next.seenRefs.size).toBe(1);
  });

  it("a full session round trip converges to silence", () => {
    // The behaviour the ticket actually wants: surface, get dismissed, surface less, then stop —
    // without anyone having to mute it.
    let state = FRESH;
    const pool = Array.from({ length: 8 }, (_, i) => scored(`n${i}.md`, 0.9));
    const first = selectAdvisories(pool, POLICY, state);
    expect(first).toHaveLength(2);
    state = recordEmission(state, first);
    state = applyFeedback(state, -1);
    const second = selectAdvisories(pool, POLICY, state);
    // budget = 3 - 1*1 - 2 = 0
    expect(second).toEqual([]);
  });
});
