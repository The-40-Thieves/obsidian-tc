// THE-726 (on-demand derivation) — the fallback writer of `agent_episodes.task_result`.
//
// `work_result` (verdict-tools.ts) is the whole first-person writer, and it is idle: measured on
// the live store 14 days after deploy, 2 stamped rows (the operator smoke test) against 620
// unstamped tool rows, 128 of them post-deploy. The pre-registered kill condition fired. The owner
// chose ON-DEMAND rather than replacing the tool: when a session has CLOSED, the server derives a
// verdict from the structural facts already in the episode log — no caller has to remember to call
// anything — and writes it through the SAME window rule (`stampOpenWindow`), so both existing
// readers (reflect.ts's hold, extractPreferences' evidence gate) keep working unchanged.
//
// DEPENDENCY, stated plainly (owner-settled, THE-726 review round 1): this pass acts only on
// sessions that EXIST and END. `session_id` is attached to a captured episode only when a session
// is open — over HTTP that requires `sessions.autoOpen` (default false) or an explicit
// `start_session`/`end_session` pair; an implicit session opened that way is only ever closed by
// the maintenance sweep's `closeStaleImplicitSessions`. On the plain stdio transport with no
// session concept in play, no episode ever carries a `session_id`, `deriveClosedWindows` finds no
// candidates, and this pass is inert by design, not broken. Measured on the live Cave deployment
// (2026-09-03): 15 sessions since 2026-08-20, 13 implicit, 12 already closed by the stale-session
// sweep, and 44 ended sessions carrying 249 derivable unstamped tool rows today — the pass fires on
// that deployment's actual traffic shape.
//
// ## The rules, stated once
//
// A window closes when its session's `ended_at` is set (cache.db `workspace_sessions`). The
// verdict is derived from four structural signals over the window's `tool_call` rows, ordered by
// `(ts, id)` — `id` is a tiebreaker, not a secondary signal: two rows can share one `ts` (same
// millisecond), and an unordered pair must still derive the SAME verdict on every run, not one that
// depends on which order two DB reads happened to return them in:
//   F1 terminal error   — the window's LAST call has `status = 'error'`.
//   F2 retry-after-error — some `args_hash` shows `status = 'error'`, recurs later in the window,
//                          and never reaches `ok` anywhere in the window.
//   S1 browse           — a search-family call that itself ENDED `ok` is followed LATER in the
//                          window by a read-family call (the caller looked at what a successful
//                          search found). An errored search proves nothing was found to look at, so
//                          it cannot seed this signal, and a read after only an errored search does
//                          not count as a browse.
//   S2 clean end        — the last call is `ok` AND S1 occurred.
//   verdict: -1 iff (F1 or F2) and not S2; +1 iff S2 and not (F1 or F2); 0 otherwise.
//
// A search followed by a re-search (different args, no read) is neither F1 nor F2 nor S1 — it is
// 0, not -1: retrying a query is not failure evidence, it only withholds the +1 a clean browse
// would have earned. `error_code` rides along on `WindowRow` because it is one of the structural
// facts already in the log, but no v1 rule reads it — it exists for a future policy version, not
// this one; reading it now would be dead code.
//
// ## Operator precedence — corrected (THE-726 review round 1)
//
// `stampOpenWindow`'s `task_result IS NULL` filter is the only thing either writer selects on, so
// an operator stamp and a derived one can never compete for the SAME row — that part holds. What
// does NOT hold is "a session has at most one window, ever": `work_result` accepts an explicit
// `asOf` (its own producer design), so an operator can judge only the dispatches up to that
// boundary and leave everything after it open. If the session later ends, the derived pass picks up
// exactly that leftover work as its OWN window. One session can therefore carry more than one
// judgement over its lifetime — an operator's partial stamp and a later derived one on the
// remainder — and that is not a race or a defect: `(session_id, verdict_at)` is the window identity
// precisely so two judgements on one session are two distinct, disjoint observations, never merged
// or overwritten.
//
// THE-726 fix round 2: a live-store query that groups derived windows to measure this pass (the
// -1 share, say) must filter `verdict_policy >= 1`. A row stamped under `TERMINAL_DRAIN_POLICY`
// was never judged by any rule, and its `task_result = 0` is a structural closure, not evidence.
import { tableExists } from "../db/introspect";
import type { Database } from "../db/types";
import { SEARCH_FAMILY_TOOLS } from "./reflect";
import { stampOpenWindow, type TaskResult, UNSTAMPED_DEBT_CLAUSES } from "./verdict";

/** THE-726: the version of the DERIVATION rule set above, stamped onto every derived verdict
 *  (`agent_episodes.verdict_policy`) so a later rule change is distinguishable from a data change —
 *  the same reason `ELIGIBILITY_POLICY_VERSION` exists beside `eligibility_reason`. Bump whenever
 *  F1/F2/S1/S2 change.
 *
 *  v2 (THE-726 review round 1): S1 now requires the seeding search call to have ENDED `ok` — v1
 *  let an ERRORED search seed a browse, so a failed search followed by an unrelated successful read
 *  derived +1 and fed a positive `preferred.search_mode` delta for the tool that just failed. */
export const DERIVATION_POLICY_VERSION = 2;

/** THE-726 fix round 2: the drain stamp's own policy value, distinct from any real derivation
 *  rule version. Policy 0 means no derivation rule judged the window; the row was closed to stop
 *  it starving the oldest-first limit (see the TERMINAL STATE note on `deriveClosedWindows`), not
 *  because F1/F2/S1/S2 evaluated it and found nothing. Real rule versions start at 1. */
export const TERMINAL_DRAIN_POLICY = 0;

/** THE-726: the read-family tools S1's "browse" signal counts as consuming a search result.
 *
 * Scoped to `read_note`/`read_notes` (m1/notes/read.ts) deliberately, not every `read_*`/`get_*`
 * verb in m1/m3 — S1 asks "did the caller look at a NOTE it found", the natural complement to a
 * search-family call, not "did it read any structural field" (frontmatter, tags, links, canvas,
 * kanban, an attachment). Widening this set is a policy change and must bump
 * `DERIVATION_POLICY_VERSION`. `derive-verdict.test.ts` snapshots the FULL `read_*`/`get_*` set the
 * live registry exposes and partitions it into this in-family set and a deliberately-excluded rest,
 * so a new read tool forces a reviewed decision instead of silently sitting in neither bucket. */
export const READ_FAMILY_TOOLS: ReadonlySet<string> = new Set(["read_note", "read_notes"]);

/** One `tool_call` episode row, exactly as needed to derive a window verdict. `id` is a tiebreaker
 *  only — two rows sharing one `ts` must still derive deterministically regardless of which order a
 *  query happens to return them in (THE-726 review round 1). Ordered by `(ts, id)` is the caller's
 *  job when it matters for a query; `deriveWindowVerdict` sorts defensively anyway (see its own
 *  note) so passing rows in insertion order is never silently wrong. */
export interface WindowRow {
  id: string;
  tool: string | null;
  status: string;
  /** Not read by any v1 rule — see the module header. */
  error_code: string | null;
  args_hash: string | null;
  ts: number;
}

/** THE-726 review round 1: a fixed comparator, `(ts, id)`, shared by `deriveWindowVerdict`'s
 *  in-memory sort and `loadWindow`'s SQL `ORDER BY` — both must agree, or a window loaded already
 *  sorted could still derive differently from one re-sorted defensively. */
function byTsThenId(a: WindowRow, b: WindowRow): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** F2: some `args_hash` shows an error, recurs later in the window (any status), and the group
 *  never reaches `ok` anywhere in the window. A `null` args_hash cannot be correlated across calls
 *  and is excluded, the same way `partitionPending`'s unstable-evidence check excludes it. */
function hasRetryAfterErrorNoRecovery(sortedByTsThenId: readonly WindowRow[]): boolean {
  const byHash = new Map<string, WindowRow[]>();
  for (const r of sortedByTsThenId) {
    if (!r.args_hash) continue;
    const group = byHash.get(r.args_hash);
    if (group) group.push(r);
    else byHash.set(r.args_hash, [r]);
  }
  for (const group of byHash.values()) {
    if (group.length < 2) continue; // never recurs -> cannot be a retry
    if (group.some((r) => r.status === "ok")) continue; // reached ok -> not F2
    // group is already in (ts, id) order (byHash was built from the sorted input); a retry exists
    // iff an error occurrence is not the LAST occurrence of its hash.
    const firstErrorIdx = group.findIndex((r) => r.status === "error");
    if (firstErrorIdx !== -1 && firstErrorIdx < group.length - 1) return true;
  }
  return false;
}

/** S1: a search-family call that itself ended `ok`, followed LATER in the window by a read-family
 *  call. THE-726 review round 1: an ERRORED search must not seed this — a failed search proves
 *  nothing was found, so a read afterward is not evidence of a successful browse, it is a caller
 *  recovering some other way. Single pass over `(ts, id)`-sorted rows: once an OK search call has
 *  been seen, any subsequent read call fires the signal. */
function hasSearchThenRead(sortedByTsThenId: readonly WindowRow[]): boolean {
  let sawOkSearch = false;
  for (const r of sortedByTsThenId) {
    if (sawOkSearch && r.tool !== null && READ_FAMILY_TOOLS.has(r.tool)) return true;
    if (r.status === "ok" && r.tool !== null && SEARCH_FAMILY_TOOLS.has(r.tool)) sawOkSearch = true;
  }
  return false;
}

/**
 * Pure derivation over one window's rows — see the module header for the rule statement. Sorts by
 * `(ts, id)` internally rather than trusting the caller's order: the WHOLE point of this function
 * is to be independently testable against hand-built fixtures, and a fixture built in narrative
 * order (not necessarily sorted) must still derive correctly and DETERMINISTICALLY — including two
 * rows sharing one `ts`, which `id` breaks the tie for.
 */
export function deriveWindowVerdict(rows: readonly WindowRow[]): TaskResult | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort(byTsThenId);
  const last = sorted[sorted.length - 1] as WindowRow;
  const f1 = last.status === "error";
  const f2 = hasRetryAfterErrorNoRecovery(sorted);
  const s1 = hasSearchThenRead(sorted);
  const s2 = last.status === "ok" && s1;
  const bad = f1 || f2;
  if (bad && !s2) return -1;
  if (s2 && !bad) return 1;
  return 0;
}

export interface DeriveClosedWindowsOutcome {
  /** Closed sessions considered this pass (had at least one open judgeable row, oldest ended_at
   *  first, capped at `opts.limit`). */
  sessionsSeen: number;
  /** THE-726 fix round 2: `drained` counts the terminal-drain stamp (see the TERMINAL STATE note
   *  below), stamped under `TERMINAL_DRAIN_POLICY`. It no longer falls into `zero`, because a
   *  rules-judged neutral `0` and an unjudged drain are not the same observation, and blending them
   *  contaminated a live-store query grouping derived windows by outcome. */
  stamped: { minus: number; zero: number; plus: number; drained: number };
  /** THE-726 review round 1: a considered session where, by the time this pass tried to stamp it,
   *  nothing remained to stamp (a race with another writer resolved it first — see the terminal-0
   *  fallback below for the "genuinely empty window" case, which is NOT this counter: that case
   *  always stamps and lands in `stamped.zero`). Rare; not an error. */
  skipped: number;
}

/** THE-726 review round 1: a defensive cap on the candidate session_id scan, enforced IN THE SQL
 *  (not by slicing the result afterward) so the query itself never asks the next step's `IN (...)`
 *  expansion for more bind parameters than this. SQLite's compiled parameter ceiling is ~32766;
 *  this leaves generous headroom for the other bound parameters in the same statement. This is a
 *  safety floor against a pathological backlog blowing up the query, not an ordering promise — the
 *  terminal-stamp fallback below (not this cap) is what actually guarantees a stuck session cannot
 *  occupy a candidate slot forever. */
const MAX_CANDIDATE_SESSIONS = 2000;

/**
 * THE-726 — find sessions that have ENDED (cache.db `workspace_sessions.ended_at IS NOT NULL`) but
 * still carry open judgeable rows in experiential.db, derive each one's verdict, and stamp it via
 * `stampOpenWindow` with `source: 'derived'`.
 *
 * Cross-store by construction: READS `workspace_sessions` from `cacheDb`, READS and WRITES
 * `agent_episodes` on `edb` only. Never writes to `cacheDb` (THE-838's cross-store isolation
 * boundary — a derived-verdict pass has no business mutating the session store it merely reads).
 * Guarded on `workspace_sessions` existing (THE-726 review round 1, mirrors maintenance.ts's
 * `job_schedule` guard): a freshly-opened cache.db that the server never provisioned has no such
 * table, and an unguarded query threw "no such table" out of both callers, which is reachable —
 * `obsidian-tc reflect` against a cacheDir the server never booted hits it directly.
 *
 * Two-step lookup rather than one cross-store JOIN (cache.db and experiential.db are separate
 * connections/files — THE-233's membrane): first the DISTINCT session ids that still have open
 * work in experiential (capped at `MAX_CANDIDATE_SESSIONS`), then those ids' `ended_at` from
 * cache.db, oldest first, capped at `opts.limit`. `opts.nowMs` additionally excludes a session
 * whose `ended_at` is somehow in the future relative to this pass's own clock (clock skew, or a
 * test fixture) — such a session is treated as not-yet-closed rather than judged early.
 *
 * TERMINAL STATE for a session whose in-bounds window is genuinely empty (THE-726 review round 1):
 * `deriveWindowVerdict` returns `null` only when every currently-open row's `ts` exceeds its own
 * session's `ended_at` — a race, or a reopened implicit session. Left alone this session would
 * re-derive `null` and be re-selected as a candidate on EVERY future pass forever, starving the
 * oldest-first cap of anything newer (reproduced by the reviewer over 5 passes at `limit: 1`). This
 * pass instead widens the ceiling to `opts.nowMs` (which covers every row a pass can see, by
 * construction — a captured row's `ts` cannot exceed the clock that captured it) and stamps a
 * NEUTRAL (`0`) terminal verdict: there is no F/S evidence to judge here, this closes a structural
 * gap rather than scoring the work, and it moves the rows out of the debt set so the session stops
 * being a candidate.
 *
 * THE-726 fix round 2: this terminal stamp writes `verdict_policy = TERMINAL_DRAIN_POLICY` (0), not
 * `DERIVATION_POLICY_VERSION`. A rules-judged neutral `0` and this drain are structurally
 * different rows (one is a rule's verdict, the other is none), and writing them under the same
 * policy value made them indistinguishable in a live-store query grouping derived windows. It
 * lands in `outcome.stamped.drained`, not `.zero`, for the same reason.
 *
 * Idempotent: a session's open rows are stamped (`task_result` no longer NULL), so a second pass
 * finds no open rows for it and does nothing.
 */
export async function deriveClosedWindows(
  edb: Database,
  cacheDb: Database,
  opts: { nowMs: number; limit?: number },
): Promise<DeriveClosedWindowsOutcome> {
  const limit = opts.limit ?? 200;
  const debtWhere = UNSTAMPED_DEBT_CLAUSES.join(" AND ");
  const outcome: DeriveClosedWindowsOutcome = {
    sessionsSeen: 0,
    stamped: { minus: 0, zero: 0, plus: 0, drained: 0 },
    skipped: 0,
  };

  const candidateIds = (
    edb
      .prepare(
        `SELECT DISTINCT session_id FROM agent_episodes
          WHERE ${debtWhere} AND session_id IS NOT NULL
          LIMIT ?`,
      )
      .all(MAX_CANDIDATE_SESSIONS) as Array<{ session_id: string }>
  ).map((r) => r.session_id);
  if (candidateIds.length === 0) return outcome;

  // THE-726 review round 1: guard against a cache.db that exists as a file but was never
  // provisioned (no migrations run) — `openDatabase` creates an empty file, and this table is the
  // FIRST thing this function reads from it.
  if (!tableExists(cacheDb, "workspace_sessions")) return outcome;

  const placeholders = candidateIds.map(() => "?").join(", ");
  const closed = cacheDb
    .prepare(
      `SELECT id, ended_at FROM workspace_sessions
        WHERE ended_at IS NOT NULL AND ended_at <= ? AND id IN (${placeholders})
        ORDER BY ended_at ASC LIMIT ?`,
    )
    .all(opts.nowMs, ...candidateIds, limit) as Array<{ id: string; ended_at: number }>;

  const loadWindow = edb.prepare(
    `SELECT id, tool, status, error_code, args_hash, ts FROM agent_episodes
      WHERE session_id = ? AND ${debtWhere} AND ts <= ?
      ORDER BY ts ASC, id ASC`,
  );

  for (const session of closed) {
    outcome.sessionsSeen++;
    const rows = loadWindow.all(session.id, session.ended_at) as WindowRow[];
    let verdict = deriveWindowVerdict(rows);
    let asOf = session.ended_at;
    // THE-726 fix round 2: `drained` distinguishes THIS branch (no rule judged the window) from a
    // rule genuinely returning 0 below: same `task_result`, different `verdict_policy`.
    let drained = false;
    if (verdict === null) {
      // See the function header's TERMINAL STATE note.
      verdict = 0;
      asOf = opts.nowMs;
      drained = true;
    }
    const out = stampOpenWindow(edb, {
      sessionId: session.id,
      result: verdict,
      now: asOf,
      asOf,
      source: "derived",
      policy: drained ? TERMINAL_DRAIN_POLICY : DERIVATION_POLICY_VERSION,
    });
    if (out.stamped === 0) {
      // Nothing left to stamp by the time we got here (a race resolved it first) — not an error.
      outcome.skipped++;
      continue;
    }
    if (drained) outcome.stamped.drained++;
    else if (verdict === -1) outcome.stamped.minus++;
    else if (verdict === 1) outcome.stamped.plus++;
    else outcome.stamped.zero++;
  }
  return outcome;
}
