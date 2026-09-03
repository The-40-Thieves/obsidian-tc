// THE-634 — goal-anchored scoring for proactive surfacing.
//
// The ticket's framing, kept because it is the whole reason this module is shaped the way it is:
// "Relevance to the *last query* is not proactivity, it is caching." So relevance here is measured
// against an OPEN GOAL, never against recent activity. A change with no goal to be relevant to
// produces nothing, by construction rather than by threshold.
//
// TWO THINGS THIS FILE DELIBERATELY DOES NOT DO:
//
//   1. It does not compute similarity. `similarity` is injected. Retrieval already owns the
//      question "how close are these two pieces of text", and a second implementation inside the
//      advisory path would drift from the one the eval harness measures — the failure THE-699 and
//      THE-806 both record, arriving through a different door. The caller wires this to the real
//      embedding seam; tests wire it to a stub and get determinism for free.
//   2. It does not decide what to SEND. Ranking and sending are different jobs with different
//      failure modes: a bad rank shows the wrong thing, a bad rate limit trains the user to dismiss
//      everything. The second half lives in advisory-policy.ts and is the part the ticket calls
//      "the part that will actually decide whether this is good".
//
// DELIVERY IS OUT OF SCOPE, and that is a measured constraint rather than a deferral of
// convenience. The only unsolicited server->client channel this server has is a
// `subscriptions/listen` stream, which is 2026-07-28 ONLY (`docs/MCP-COMPATIBILITY.md`: legacy
// reads `n/a`). Production reaches obsidian-tc through LiteLLM, which pins `mcp` 1.28.1 with a
// 2025-11-25 ceiling, so no advisory could be delivered to it today whatever this module produced.
// Scoring is buildable and testable now; the transport is not, and shipping one into a stream
// nothing can subscribe to is the failure this ticket's own banner cites against THE-633.
/**
 * The goal fields scoring needs — STRUCTURAL, and deliberately not `GoalRow` from `./goals`.
 *
 * `goals.test.ts` constraint 3 asserts that nothing under `experiential/` imports the goals store,
 * because `reflect.ts` gaining a goals write would mean stated intent stops being stated — the one
 * assumption the membrane decision rests on. A first draft here used `import type { GoalRow }`,
 * which is erased at runtime and carries no write capability, and the gate flagged it anyway
 * because its detection is a source regex that cannot tell a type import from a value one.
 *
 * The gate is right to be blunt, and the fix is not to teach it an exemption: this module never
 * needed the store's row shape, only three fields. Taking them structurally removes the import edge
 * entirely, leaves a security-adjacent invariant untouched, and lets the scorer be tested without
 * the goals module at all. `GoalRow` is structurally assignable, so callers pass rows directly.
 */
export interface AdvisoryGoal {
  id: string;
  text: string;
  status: string;
}

/** Something that happened and might be worth mentioning: a changed note, or derived-plane output.
 *  `text` is what gets compared to the goal — a title plus a snippet, not a whole note.
 *
 *  THE-934 fix round 2 follow-up (NB2): a DISCRIMINATED union, not one shape with an optional
 *  `path` — round 2 made `path` optional on all three kinds, and `path ?? ""` at the one call site
 *  that read it was fail-OPEN (an absent path cleared the exclusion filter instead of tripping it).
 *  Requiring `path` on exactly the "note_changed" variant makes a pathless note-changed candidate a
 *  TYPE ERROR at every construction site, not merely a runtime possibility a filter has to guess
 *  about.
 *
 *  THE-934 fix round 3 (A): round 2 was wrong that "contradiction"/"synthesis" carry no vault path
 *  at all — a contradiction's `text` is `${source_path} vs ${conflict_path}: ${rationale}` and a
 *  synthesis's `text` is the judge model's own `patterns` JSON, whose `evidence_paths` name the
 *  chunks it drew on; both were egressing real vault paths under an opaque `ref` (a row id /
 *  `synthesis-<year>-<week>`) the exclusion filter could never match. Both variants now carry
 *  `paths: string[]` — a contradiction's is always exactly `[source_path, conflict_path]` (both
 *  columns are NOT NULL); a synthesis's is the union of every pattern's `evidence_paths`, which is
 *  EMPTY when the row's `patterns` JSON fails to parse or declares no evidence — advisory-sweep.ts's
 *  filter treats an empty `paths` on these two kinds as EXCLUDED (fail closed), never as "nothing to
 *  check". */
export type AdvisoryCandidate =
  | {
      kind: "note_changed";
      /** The chunk_retrievals FK identity — a real chunk id, a content hash, NOT a vault path. */
      ref: string;
      /** The real vault-relative path, for the egress exclusion filter and the embedding port's
       *  `sourcePaths` backstop. Required, not optional — see the type-level doc comment above. */
      path: string;
      text: string;
      at: number;
    }
  | {
      kind: "contradiction" | "synthesis";
      /** A derived-row id (e.g. a contradiction id or `synthesis-<year>-<week>`) — never a vault
       *  path itself, so exclusion is checked against `paths` below, not `ref`. */
      ref: string;
      /** The real vault path(s) `text` was drawn from. EMPTY means "no provenance available" and
       *  must be treated as EXCLUDED by any filtering caller — see the type-level doc comment. */
      paths: string[];
      text: string;
      at: number;
    };

/** One scored (goal, candidate) pair. Not yet a thing to send — see advisory-policy.ts. */
export interface ScoredAdvisory {
  goalId: string;
  goalText: string;
  candidate: AdvisoryCandidate;
  /** 0..1 from the injected similarity. Higher is more relevant to that goal. */
  score: number;
}

/** Injected relevance. Must be the SAME notion of similarity retrieval uses — see the header. */
export type SimilarityFn = (goalText: string, candidateText: string) => number;

/**
 * Score every candidate against every OPEN goal, best pairing per candidate, ranked.
 *
 * One pair per candidate, not one per (goal, candidate): a note that touches three goals is still
 * one thing to mention, and emitting it three times is how a "top 2" limit silently becomes a
 * digest of the same item. The winning goal travels with it so the advisory can say *why*.
 *
 * Closed goals are dropped here rather than at the query: `listGoals` defaults to open, but a
 * caller passing `status: "any"` must not accidentally surface work against an abandoned goal.
 */
export function scoreAgainstGoals(
  goals: readonly AdvisoryGoal[],
  candidates: readonly AdvisoryCandidate[],
  similarity: SimilarityFn,
): ScoredAdvisory[] {
  const open = goals.filter((g) => g.status === "open");
  if (open.length === 0 || candidates.length === 0) return [];

  const best: ScoredAdvisory[] = [];
  for (const candidate of candidates) {
    let winner: ScoredAdvisory | undefined;
    for (const goal of open) {
      const score = similarity(goal.text, candidate.text);
      if (!Number.isFinite(score)) continue;
      if (winner === undefined || score > winner.score) {
        winner = { goalId: goal.id, goalText: goal.text, candidate, score };
      }
    }
    if (winner !== undefined) best.push(winner);
  }

  // Ties broken by recency, so a stale note cannot outrank a fresh one it merely equals. Stable
  // beyond that: two candidates identical on both axes keep input order rather than shuffling
  // between runs, which would make the "same advisory twice" dedupe in the policy layer unreliable.
  return best.sort((a, b) => b.score - a.score || b.candidate.at - a.candidate.at);
}
