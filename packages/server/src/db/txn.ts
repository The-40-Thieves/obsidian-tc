// A single correct BEGIN/COMMIT/ROLLBACK shape, so handlers that need one do not each
// hand-roll it (THE-572). The repo already had the pattern inline in half a dozen places;
// the two failure modes it gets wrong when written by hand are both handled here.
import type { Database } from "./types";

/**
 * Run `fn` inside a SQLite transaction on `db` and return its value.
 *
 * Two things this gets right that an inline `BEGIN` / `try` / `catch { ROLLBACK; throw }` does not:
 *
 *  1. **A failing ROLLBACK never replaces the real error.** SQLite may have already auto-rolled
 *     back the transaction (a `SQLITE_FULL`/`SQLITE_BUSY` class error does this), in which case the
 *     explicit `ROLLBACK` throws "cannot rollback - no transaction is active". Thrown from a bare
 *     catch block, that error *replaces* the statement or COMMIT error that actually explains the
 *     failure, and the caller is left debugging the wrong thing. Here it is swallowed — the
 *     transaction is already in the state we wanted it in either way.
 *  2. **`BEGIN` failing is not treated as a rollback-able failure.** It sits outside the `try`
 *     deliberately: if it throws (most likely because this connection is *already* inside a
 *     transaction), no transaction was opened by us, so there is nothing to roll back and rolling
 *     back would destroy the *caller's* outer transaction. The error propagates untouched.
 *
 * Not re-entrant, by construction: SQLite has no nested transactions, only SAVEPOINTs. A caller
 * that may already be inside a transaction must use a savepoint instead of this helper.
 */
export function inTransaction<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN");
  let committed = false;
  try {
    const out = fn();
    db.exec("COMMIT");
    committed = true;
    return out;
  } finally {
    if (!committed) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Already auto-rolled-back, or the rollback itself failed. Either way the transaction is
        // not committed, which is the outcome we need — and this must never mask the original throw.
      }
    }
  }
}
