// THE-726 — the task-verdict producer. Design:
// docs/superpowers/specs/2026-08-16-the-726-task-verdict-producer-design-v2.md
//
// `agent_episodes.task_result` has had READERS AND NO WRITER since it was renamed in 20260806_003.
// Two live consumers sit on it and both are inert at 0 of 630 rows: reflect.ts holds a bad-result
// episode out of promotion, and gates the preference-extraction evidence set. This module is the
// writer, and the whole epic's constraint 3 applies to it — it closes on a row count after a real
// deploy, never on being registered.
//
// ## The grain problem this solves
//
// An episode is ONE DISPATCH. `episodes.ts` writes one row per dispatch outcome, and the live store
// is 630 such rows. A task is not a dispatch: measured, a session carries 4.82 of them (range
// 1-18). So "stamp the episode" had two incompatible readings, and the producer could not be
// written until one was chosen.
//
// The chosen unit is THE SESSION, with the verdict projected onto the window's judgeable rows, so
// both reflect.ts readers keep working on the column they already read. `20260806_003`'s own
// justification for keeping that column — "an episode IS the task, one row one task one verdict" —
// is false against the writer, and calling the projection a fix for that would be renaming the
// problem. What makes the row-grain column honest is `(session_id, verdict_at)`: it recovers
// exactly which rows share one judgement, and every consumer MUST group on it (see debtQuery's note
// and THE-673).
//
// ## The estimand, stated rather than overclaimed
//
// A stamp applies to every judgeable row in the session with no verdict and `ts <= as_of`. It is
// NOT a claim about the agent's conceptual task boundary, because the server cannot observe one:
// the UPDATE is atomic but the agent's JUDGEMENT is not formed atomically with it, so a dispatch
// committed in between is swept in. An earlier draft of this design claimed stamping per task
// "partitions the session exactly"; that is false under concurrent dispatch and is withdrawn.
// `as_of` exists so a caller that DOES know its boundary can pin it.

import { inWriteTransaction } from "../db/txn";
import type { Database } from "../db/types";

/** -1 bad, 0 neutral, +1 good. Mirrors the column's documented domain. */
export type TaskResult = -1 | 0 | 1;

/** THE-726 (on-demand derivation): which of the two writers produced this verdict.
 *  'operator' — work_result, a first-person judgement of the task the caller just ran.
 *  'derived'  — the derived-verdict pass, inferring a verdict from a closed session's tool-call
 *               log (see derive-verdict.ts). The two are not interchangeable evidence: reflect.ts's
 *               hold rule trusts an operator '-1' unconditionally and a derived '-1' only when
 *               `experiential.derivedVerdictHold` is on. */
export type VerdictSource = "operator" | "derived";

export interface StampOptions {
  sessionId: string;
  result: TaskResult;
  /** Verdict timestamp; half of the window identity. */
  now: number;
  /** Ceiling on `ts`. Defaults to `now`. Clamped by the caller, not here. */
  asOf?: number;
  /** THE-726: which writer produced this verdict. Required, not defaulted — a caller must state
   *  which kind of evidence it is producing rather than one falling silently into the other's
   *  column. */
  source: VerdictSource;
  /** THE-726: the derivation rule version, for a 'derived' verdict only. `stampOpenWindow` writes
   *  it verbatim (NULL when absent) — an 'operator' stamp never carries one, because there is no
   *  rule to version; the operator IS the judgement. */
  policy?: number;
}

export interface StampOutcome {
  /** Rows that received the verdict. 0 is a legitimate, reportable result — an empty window. */
  stamped: number;
  /** Rows demoted back to `pending` so the hold rule can re-evaluate them (see below). */
  demoted: number;
  /** The `verdict_at` written. With `session_id`, identifies this window. */
  verdictAt: number;
}

/**
 * Stamp every unjudged, judgeable dispatch in a session up to `as_of`, then reopen the window.
 *
 * `task_result IS NULL` IS the window. Nothing about it is stored, so nothing about it can drift:
 * an agent that stamps once at close covers the session, one that stamps after each task partitions
 * it, and one that never stamps leaves the window open — which is the debt state the queue must be
 * able to see.
 *
 * `episode_type = 'tool_call'` is the judgeability filter, and it is STRUCTURAL (THE-839). It is
 * deliberately not a test on the tool's NAME: SEP-986 permits `/` in tool names so they can be
 * hierarchical (`user-profile/update` is a documented valid example), so a name test would
 * misclassify a spec-conforming tool and keep doing it silently. `protocol` rows are MCP methods,
 * not work anyone can render a verdict on; `verdict` rows are the stamping verbs themselves, which
 * must never become their own evidence — without that exclusion every stamp would strand its own
 * dispatch row and the debt queue could never drain.
 */
export function stampOpenWindow(edb: Database, opts: StampOptions): StampOutcome {
  const asOf = opts.asOf ?? opts.now;
  return inWriteTransaction(edb, "task_verdict", () => {
    // `(session_id, verdict_at)` is this design's WINDOW IDENTITY — the pair every consumer uses to
    // tell which rows carry one judgement. So it has to actually BE unique, and a wall-clock
    // millisecond is not: two stamps in the same session within the same millisecond collide.
    //
    // That is not theoretical. Measured before this guard existed: stamping +1 and then -1 at the
    // same `now` reported `demoted: 2` and moved the +1 window's rows to `pending` — a GOOD
    // verdict's episodes held out of promotion by an unrelated later verdict. The dedup in
    // extractPreferences fails the same way, merging two distinct judgements into one line and
    // taking whichever it saw first.
    //
    // Advancing to the next free millisecond makes the identity real rather than patching each
    // consumer to tolerate a key that is not a key. Bounded by construction: it only advances past
    // values this session has actually used, and it never moves backwards, so `verdict_at` stays
    // monotonic per session and orderable.
    const taken = edb
      .prepare("SELECT 1 FROM agent_episodes WHERE session_id = ? AND verdict_at = ? LIMIT 1")
      .get(opts.sessionId, opts.now);
    let verdictAt = opts.now;
    if (taken !== undefined && taken !== null) {
      const maxRow = edb
        .prepare("SELECT MAX(verdict_at) AS m FROM agent_episodes WHERE session_id = ?")
        .get(opts.sessionId) as { m: number | null } | undefined;
      verdictAt = (maxRow?.m ?? opts.now) + 1;
    }

    const stamped = edb
      .prepare(
        `UPDATE agent_episodes
            SET task_result = ?, verdict_at = ?, verdict_source = ?, verdict_policy = ?
          WHERE session_id = ?
            AND task_result IS NULL
            AND episode_type = 'tool_call'
            AND ts <= ?`,
      )
      .run(opts.result, verdictAt, opts.source, opts.policy ?? null, opts.sessionId, asOf)
      .changes as number;

    // THE-726 review finding: `reflect.ts`'s hold rule is ORDER-DEPENDENT, and close-time stamping
    // is exactly the order that defeats it. `evaluateEpisodes` selects `eligibility = 'pending'`
    // and promotes to `'eligible'`; nothing ever re-inspects a promoted row. So a -1 arriving after
    // promotion never fires `held_bad_task_result`, and a failed task's episodes stay retrievable —
    // the precise outcome that rule exists to prevent.
    //
    // Demoting the rows this verdict just condemned puts them back in the evaluator's pool, where
    // the hold applies and records its own reason (THE-746). This is consistent with the existing
    // model rather than a new state: a HELD row already keeps `eligibility = 'pending'`, so pending
    // means "not yet promoted", not "never seen".
    //
    // ONLY -1 demotes. A 0 or +1 verdict changes no promotion decision, and demoting on every stamp
    // would re-run the evaluator over the whole corpus for no change in outcome.
    const demoted =
      opts.result === -1
        ? (edb
            .prepare(
              `UPDATE agent_episodes
                  SET eligibility = 'pending', eligibility_reason = NULL, eligibility_policy = NULL
                WHERE session_id = ? AND verdict_at = ? AND eligibility = 'eligible'`,
            )
            .run(opts.sessionId, verdictAt).changes as number)
        : 0;

    return { stamped, demoted, verdictAt };
  });
}

/**
 * The debt predicate, as SQL clauses, so the writer and every reader share ONE definition of what
 * counts as unjudged work. `work_episodes` ANDs these onto its own query rather than calling a
 * standalone reader, which is what keeps the P1.7 caller partition applied — a separate debt query
 * would have shown every principal's unjudged work to anyone holding read:workspace.
 *
 * Age is deliberately NOT baked in. An earlier draft derived debt from session CLOSURE and then
 * from session-level `MAX(ts)` idleness; both were wrong, the second actively so — repeated
 * protocol chatter keeps a session's max fresh and would hide its old unstamped rows indefinitely.
 * Callers express "older than" with the existing `until` time filter, over per-ROW `ts`, so each row
 * ages on its own clock and nothing can mask anything else.
 */
export const UNSTAMPED_DEBT_CLAUSES: readonly string[] = [
  "task_result IS NULL",
  "episode_type = 'tool_call'",
];
