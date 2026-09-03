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
// ## The rules, stated once
//
// A window closes when its session's `ended_at` is set (cache.db `workspace_sessions`). The
// verdict is derived from four structural signals over the window's `tool_call` rows, ordered by
// `ts`:
//   F1 terminal error   — the window's LAST call has `status = 'error'`.
//   F2 retry-after-error — some `args_hash` shows `status = 'error'`, recurs later in the window,
//                          and never reaches `ok` anywhere in the window.
//   S1 browse           — a search-family call is followed LATER in the window by a read-family
//                          call (the caller looked at what it found).
//   S2 clean end        — the last call is `ok` AND S1 occurred.
//   verdict: -1 iff (F1 or F2) and not S2; +1 iff S2 and not (F1 or F2); 0 otherwise.
//
// A search followed by a re-search (different args, no read) is neither F1 nor F2 nor S1 — it is
// 0, not -1: retrying a query is not failure evidence, it only withholds the +1 a clean browse
// would have earned. `error_code` rides along on `WindowRow` because it is one of the structural
// facts already in the log, but no v1 rule reads it — it exists for a future policy version, not
// this one; reading it now would be dead code.
//
// ## Operator precedence, by construction
//
// A live session's operator stamp (`work_result`) closes its window before the session ends —
// `stampOpenWindow`'s `task_result IS NULL` filter means there is nothing left for the derived pass
// to see once an operator has judged it. A derived stamp only ever touches windows in ENDED
// sessions, so the two writers cannot race for the same rows: no code enforces this, the window
// definitions are simply disjoint.
import type { Database } from "../db/types";
import { SEARCH_FAMILY_TOOLS } from "./reflect";
import { stampOpenWindow, type TaskResult, UNSTAMPED_DEBT_CLAUSES } from "./verdict";

/** THE-726: the version of the DERIVATION rule set above, stamped onto every derived verdict
 *  (`agent_episodes.verdict_policy`) so a later rule change is distinguishable from a data change —
 *  the same reason `ELIGIBILITY_POLICY_VERSION` exists beside `eligibility_reason`. Bump whenever
 *  F1/F2/S1/S2 change. */
export const DERIVATION_POLICY_VERSION = 1;

/** THE-726: the read-family tools S1's "browse" signal counts as consuming a search result.
 *
 * Scoped to `read_note`/`read_notes` (m1/notes/read.ts) deliberately, not every `read_*`/`get_*`
 * verb in m1/m3 — S1 asks "did the caller look at a NOTE it found", the natural complement to a
 * search-family call, not "did it read any structural field" (frontmatter, tags, links, canvas,
 * kanban, an attachment). Widening this set is a policy change and must bump
 * `DERIVATION_POLICY_VERSION`. `derive-verdict.test.ts` asserts both names against the live tool
 * registry so a rename fails loudly instead of silently narrowing this signal to nothing. */
export const READ_FAMILY_TOOLS: ReadonlySet<string> = new Set(["read_note", "read_notes"]);

/** One `tool_call` episode row, exactly as needed to derive a window verdict. Ordered by `ts` is
 *  the caller's job when it matters for a query; `deriveWindowVerdict` sorts defensively anyway
 *  (see its own note) so passing rows in insertion order is never silently wrong. */
export interface WindowRow {
  tool: string | null;
  status: string;
  /** Not read by any v1 rule — see the module header. */
  error_code: string | null;
  args_hash: string | null;
  ts: number;
}

/** F2: some `args_hash` shows an error, recurs later in the window (any status), and the group
 *  never reaches `ok` anywhere in the window. A `null` args_hash cannot be correlated across calls
 *  and is excluded, the same way `partitionPending`'s unstable-evidence check excludes it. */
function hasRetryAfterErrorNoRecovery(sortedByTs: readonly WindowRow[]): boolean {
  const byHash = new Map<string, WindowRow[]>();
  for (const r of sortedByTs) {
    if (!r.args_hash) continue;
    const group = byHash.get(r.args_hash);
    if (group) group.push(r);
    else byHash.set(r.args_hash, [r]);
  }
  for (const group of byHash.values()) {
    if (group.length < 2) continue; // never recurs -> cannot be a retry
    if (group.some((r) => r.status === "ok")) continue; // reached ok -> not F2
    // group is already in ts order (byHash was built from sortedByTs); a retry exists iff an
    // error occurrence is not the LAST occurrence of its hash.
    const firstErrorIdx = group.findIndex((r) => r.status === "error");
    if (firstErrorIdx !== -1 && firstErrorIdx < group.length - 1) return true;
  }
  return false;
}

/** S1: a search-family call followed LATER in the window by a read-family call. Single pass over
 *  ts-sorted rows: once a search call has been seen, any subsequent read call fires the signal. */
function hasSearchThenRead(sortedByTs: readonly WindowRow[]): boolean {
  let sawSearch = false;
  for (const r of sortedByTs) {
    if (sawSearch && r.tool !== null && READ_FAMILY_TOOLS.has(r.tool)) return true;
    if (r.tool !== null && SEARCH_FAMILY_TOOLS.has(r.tool)) sawSearch = true;
  }
  return false;
}

/**
 * Pure derivation over one window's rows — see the module header for the rule statement. Sorts by
 * `ts` internally rather than trusting the caller's order: the WHOLE point of this function is to
 * be independently testable against hand-built fixtures, and a fixture built in narrative order
 * (not necessarily `ts` order) must still derive correctly.
 */
export function deriveWindowVerdict(rows: readonly WindowRow[]): TaskResult | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => a.ts - b.ts);
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
  stamped: { minus: number; zero: number; plus: number };
  /** A considered session whose window derived `null` — every open row's `ts` exceeded its
   *  session's `ended_at` (a race, or a reopened implicit session), so there was nothing in bounds
   *  to judge. Not an error: `stampOpenWindow` is simply never called for it. */
  skipped: number;
}

/**
 * THE-726 — find sessions that have ENDED (cache.db `workspace_sessions.ended_at IS NOT NULL`) but
 * still carry open judgeable rows in experiential.db, derive each one's verdict, and stamp it via
 * `stampOpenWindow` with `source: 'derived'`.
 *
 * Cross-store by construction: READS `workspace_sessions` from `cacheDb`, READS and WRITES
 * `agent_episodes` on `edb` only. Never writes to `cacheDb` (THE-838's cross-store isolation
 * boundary — a derived-verdict pass has no business mutating the session store it merely reads).
 *
 * Two-step lookup rather than one cross-store JOIN (cache.db and experiential.db are separate
 * connections/files — THE-233's membrane): first the DISTINCT session ids that still have open
 * work in experiential, then those ids' `ended_at` from cache.db, oldest first, capped at
 * `opts.limit`. `opts.nowMs` additionally excludes a session whose `ended_at` is somehow in the
 * future relative to this pass's own clock (clock skew, or a test fixture) — such a session is
 * treated as not-yet-closed rather than judged early.
 *
 * Idempotent: a session's open rows are stamped (`task_result` no longer NULL for any row with
 * `ts <= ended_at`), so a second pass finds no open rows for it and does nothing.
 */
export async function deriveClosedWindows(
  edb: Database,
  cacheDb: Database,
  opts: { nowMs: number; limit?: number },
): Promise<DeriveClosedWindowsOutcome> {
  const limit = opts.limit ?? 200;
  const debtWhere = UNSTAMPED_DEBT_CLAUSES.join(" AND ");
  const candidateIds = (
    edb
      .prepare(
        `SELECT DISTINCT session_id FROM agent_episodes WHERE ${debtWhere} AND session_id IS NOT NULL`,
      )
      .all() as Array<{ session_id: string }>
  ).map((r) => r.session_id);

  const outcome: DeriveClosedWindowsOutcome = {
    sessionsSeen: 0,
    stamped: { minus: 0, zero: 0, plus: 0 },
    skipped: 0,
  };
  if (candidateIds.length === 0) return outcome;

  const placeholders = candidateIds.map(() => "?").join(", ");
  const closed = cacheDb
    .prepare(
      `SELECT id, ended_at FROM workspace_sessions
        WHERE ended_at IS NOT NULL AND ended_at <= ? AND id IN (${placeholders})
        ORDER BY ended_at ASC LIMIT ?`,
    )
    .all(opts.nowMs, ...candidateIds, limit) as Array<{ id: string; ended_at: number }>;

  const loadWindow = edb.prepare(
    `SELECT tool, status, error_code, args_hash, ts FROM agent_episodes
      WHERE session_id = ? AND ${debtWhere} AND ts <= ?
      ORDER BY ts ASC`,
  );

  for (const session of closed) {
    outcome.sessionsSeen++;
    const rows = loadWindow.all(session.id, session.ended_at) as WindowRow[];
    const verdict = deriveWindowVerdict(rows);
    if (verdict === null) {
      outcome.skipped++;
      continue;
    }
    stampOpenWindow(edb, {
      sessionId: session.id,
      result: verdict,
      now: session.ended_at,
      asOf: session.ended_at,
      source: "derived",
      policy: DERIVATION_POLICY_VERSION,
    });
    if (verdict === -1) outcome.stamped.minus++;
    else if (verdict === 1) outcome.stamped.plus++;
    else outcome.stamped.zero++;
  }
  return outcome;
}
