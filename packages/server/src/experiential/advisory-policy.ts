// THE-634 — the interrupt threshold. Lifted out of advisory.ts for the same reason
// feedback-scope.ts was lifted out of experiential-tools.ts: it stopped being a clause you read
// inline the moment "how many, and when do we stop" had to explain itself.
//
// The ticket is blunt that THIS is the ticket, not the plumbing:
//
//   "A proactive system that is wrong 30% of the time is worse than no proactive system, because
//    users learn to dismiss it and then miss the 70%."
//
// So the four requirements below are load-bearing, and each maps to a function or a field here:
// precision over recall (`minScore`, and a hard `topK` cap), never a digest (`topK` defaults to 2
// and is applied AFTER filtering, not before), a hard per-session rate limit that decays on
// dismissal (`remainingBudget`), and dismissals recorded as signal rather than silently absorbed.
//
// The dismissal channel is deliberately NOT a new table. `chunk_retrievals.feedback` already
// carries a -1/0/+1 axis with a caller partition (THE-568) and a live writer
// (`record_retrieval_feedback`), and the ticket says to reuse it. A second feedback path would be
// a second thing to keep honest, and this repo has enough of those.
import type { ScoredAdvisory } from "./advisory";

/** The tuning surface.
 *
 *  Deliberately NOT a config block yet. A first draft of this PR added `experiential.proactive.*`
 *  and `check-config-threading` refused it: *"3 DECLARED-BUT-UNREAD config key(s) ... A config key
 *  nothing reads is a promise to the operator that the code does not keep."* It was right — with
 *  delivery deferred, nothing would have read them, which is the substrate-ahead-of-a-consumer
 *  shape this ticket exists to avoid repeating. The config surface lands with the code that honours
 *  it. Callers pass a policy object until then. */
export interface AdvisoryPolicy {
  /** Below this, a candidate is not worth interrupting for. Precision over recall. */
  minScore: number;
  /** Hard cap per emission. 1 or 2. The ticket: "Surface the top 1-2 items, never a digest." */
  topK: number;
  /** Hard cap per session, before decay. */
  maxPerSession: number;
  /** Budget removed per dismissal. At 1, three dismissals exhaust a budget of three. */
  dismissalPenalty: number;
}

/** What this session has already spent. Caller-owned; this module is pure. */
export interface AdvisorySessionState {
  /** Advisories already emitted in this session. */
  emitted: number;
  /** Advisories the user explicitly dismissed (a -1 through the feedback column). */
  dismissed: number;
  /** `candidate.ref`s already surfaced this session. Re-surfacing the same note is the fastest
   *  way to train someone to ignore the channel. */
  seenRefs: ReadonlySet<string>;
}

/**
 * How many more advisories this session may receive.
 *
 * Decay is subtractive rather than multiplicative on purpose: someone who dismisses twice has said
 * something specific about THIS session, and a hard floor of zero is easier to reason about — and
 * to test — than a decaying rate that asymptotically still fires. Never negative.
 */
export function remainingBudget(policy: AdvisoryPolicy, state: AdvisorySessionState): number {
  const decayed = policy.maxPerSession - policy.dismissalPenalty * state.dismissed;
  return Math.max(0, decayed - state.emitted);
}

/**
 * Choose what to surface now — at most `topK`, at most the remaining budget, never a repeat.
 *
 * Order matters and is the whole correctness argument:
 *
 *   1. drop anything already surfaced this session   (repeats are worse than silence)
 *   2. drop anything below `minScore`                (precision over recall)
 *   3. take at most `topK`                           (never a digest)
 *   4. take at most `remainingBudget`                (the hard rate limit wins over everything)
 *
 * Filtering BEFORE capping is what makes "top 2" mean "the best 2 that qualify" rather than "the
 * best 2, some of which may be junk". Capping first would let a low scorer occupy a slot a better
 * candidate below it in the list could have used — and since `scoreAgainstGoals` returns ranked
 * output, that slot is silently wasted rather than visibly wrong.
 *
 * Input is assumed ranked (it comes from `scoreAgainstGoals`); this does not re-sort, so a caller
 * that hand-builds a list is responsible for its own order.
 */
export function selectAdvisories(
  ranked: readonly ScoredAdvisory[],
  policy: AdvisoryPolicy,
  state: AdvisorySessionState,
): ScoredAdvisory[] {
  const budget = remainingBudget(policy, state);
  if (budget <= 0) return [];
  const limit = Math.min(policy.topK, budget);
  if (limit <= 0) return [];

  const out: ScoredAdvisory[] = [];
  for (const item of ranked) {
    if (state.seenRefs.has(item.candidate.ref)) continue;
    if (item.score < policy.minScore) continue;
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Fold a dismissal into session state.
 *
 * `feedback` is the raw -1/0/+1 from `chunk_retrievals.feedback`. Only -1 counts against the
 * budget: 0 is "seen, no opinion" and +1 is the channel working. Treating 0 as a dismissal would
 * make silence expensive, and silence is the common case.
 */
export function applyFeedback(state: AdvisorySessionState, feedback: number): AdvisorySessionState {
  if (feedback >= 0) return state;
  return { ...state, dismissed: state.dismissed + 1 };
}

/** Record an emission so the budget and the repeat-guard both move. */
export function recordEmission(
  state: AdvisorySessionState,
  emitted: readonly ScoredAdvisory[],
): AdvisorySessionState {
  if (emitted.length === 0) return state;
  const seen = new Set(state.seenRefs);
  for (const a of emitted) seen.add(a.candidate.ref);
  return { ...state, emitted: state.emitted + emitted.length, seenRefs: seen };
}
