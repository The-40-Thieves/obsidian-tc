// THE-633 — stated goals: the plane's model of what the user is TRYING to do.
//
// Deliberately the thinnest possible store. Goals are STATED, never inferred, so there is no
// extractor here and no judge — the whole surface is three verbs a user drives directly. That is the
// write-path trust boundary the membrane decision settled on: the table lives in the low-trust
// experiential store, and what keeps an injected episode from writing one is that no inference path
// can reach these functions, plus a `source` CHECK that makes an inferred write a constraint
// violation rather than a convention.
//
// AUTHORITY MONOTONICITY (decision constraint 4): there is no strengthen/weaken/adjust here. The
// only legal transition is open -> terminal, once. A closed goal is immutable; reopening is not a
// verb, because "the system quietly reopened a goal you completed" is precisely the class of
// low-confidence mutation the constraint exists to forbid.
import type { Database } from "../db/types";

/** Terminal states. `expired` is the sweep's verdict; `abandoned` is the user's. Kept distinct so
 *  "gave up" and "ran out of time" never collapse into one number downstream. */
export type GoalStatus = "open" | "completed" | "abandoned" | "expired";

export interface GoalRow {
  id: string;
  vault_id: string;
  text: string;
  status: GoalStatus;
  source: "stated";
  created_at: number;
  target_date: number | null;
  closed_at: number | null;
}

function tableReady(edb: Database): boolean {
  return (
    edb.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='goals'").get() !==
    undefined
  );
}

/**
 * Record a stated goal. `source` is hard-coded rather than parameterised — a caller cannot ask for
 * a different provenance, so the CHECK in the migration is a second line of defence rather than the
 * only one.
 */
export function setGoal(
  edb: Database,
  input: {
    id: string;
    vaultId: string;
    text: string;
    createdAt: number;
    targetDate?: number | null;
  },
): GoalRow {
  edb
    .prepare(
      `INSERT INTO goals (id, vault_id, text, status, source, created_at, target_date, closed_at)
     VALUES (?, ?, ?, 'open', 'stated', ?, ?, NULL)`,
    )
    .run(input.id, input.vaultId, input.text, input.createdAt, input.targetDate ?? null);
  return {
    id: input.id,
    vault_id: input.vaultId,
    text: input.text,
    status: "open",
    source: "stated",
    created_at: input.createdAt,
    target_date: input.targetDate ?? null,
    closed_at: null,
  };
}

/** This vault's goals, newest first. `status` omitted means open only — the common read, and the
 *  safe default: a consumer that forgot to filter should see current intent, not a graveyard. */
export function listGoals(
  edb: Database,
  vaultId: string,
  opts: { status?: GoalStatus | "any"; limit?: number } = {},
): GoalRow[] {
  if (!tableReady(edb)) return [];
  const limit = opts.limit ?? 50;
  const status = opts.status ?? "open";
  if (status === "any") {
    return edb
      .prepare("SELECT * FROM goals WHERE vault_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(vaultId, limit) as GoalRow[];
  }
  return edb
    .prepare(
      "SELECT * FROM goals WHERE vault_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(vaultId, status, limit) as GoalRow[];
}

/**
 * Close a goal into a terminal state. Returns null when nothing changed, which covers both "no such
 * goal in this vault" and "already closed" — the caller is told it did not happen rather than being
 * handed a success that silently did nothing.
 *
 * The `status = 'open'` predicate is what makes this once-only: a second close changes 0 rows.
 */
export function closeGoal(
  edb: Database,
  input: {
    id: string;
    vaultId: string;
    status: Exclude<GoalStatus, "open">;
    closedAt: number;
  },
): GoalRow | null {
  if (!tableReady(edb)) return null;
  const res = edb
    .prepare(
      "UPDATE goals SET status = ?, closed_at = ? WHERE id = ? AND vault_id = ? AND status = 'open'",
    )
    .run(input.status, input.closedAt, input.id, input.vaultId);
  if ((res.changes as number) === 0) return null;
  return (
    (edb
      .prepare("SELECT * FROM goals WHERE id = ? AND vault_id = ?")
      .get(input.id, input.vaultId) as GoalRow | undefined) ?? null
  );
}

/**
 * Mark overdue open goals `expired`. Returns the number expired.
 *
 * A SWEEP, not a delete — see the migration header. Note the asymmetry with `abandoned`: this is the
 * system's verdict about a deadline, never a judgement that the user gave up, and the two must not
 * be conflated by any consumer that counts them.
 */
export function expireOverdueGoals(edb: Database, nowMs: number): number {
  if (!tableReady(edb)) return 0;
  const res = edb
    .prepare(
      "UPDATE goals SET status = 'expired', closed_at = ? WHERE status = 'open' AND target_date IS NOT NULL AND target_date < ?",
    )
    .run(nowMs, nowMs);
  return res.changes as number;
}
