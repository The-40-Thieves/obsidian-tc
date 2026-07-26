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
  let out: T;
  try {
    out = fn();
  } catch (primary) {
    rollback(db, primary);
    throw primary;
  }
  try {
    db.exec("COMMIT");
  } catch (commitErr) {
    // A COMMIT that throws may or may not have left the transaction open; roll back to be sure.
    rollback(db, commitErr);
    throw commitErr;
  }
  return out;
}

/**
 * THE-573: the nested-safe counterpart to `inTransaction`.
 *
 * `inTransaction` is non-reentrant by construction — SQLite has no nested transactions — so a
 * caller that might ALREADY be inside one had no helper at all and had to hand-roll a savepoint,
 * which is precisely the duplication `inTransaction` exists to prevent.
 *
 * A SAVEPOINT works standalone too (it opens a transaction if none is active), so this is safe
 * whether or not there is an outer transaction. On failure only the work since the savepoint is
 * undone; an enclosing transaction is left intact and still commits.
 *
 * Names are unique per call because savepoints nest: reusing one name would make `ROLLBACK TO`
 * unwind to the OUTERMOST savepoint of that name, silently discarding more than the caller asked.
 *
 * The rollback discipline matches `inTransaction`: the primary error always propagates, and a
 * genuine `ROLLBACK TO` failure is attached as a non-enumerable `rollbackError` rather than thrown
 * in its place.
 */
let savepointSeq = 0;
export function inSavepoint<T>(db: Database, fn: () => T): T {
  savepointSeq = (savepointSeq + 1) % Number.MAX_SAFE_INTEGER;
  const name = `sp_${savepointSeq}`;
  db.exec(`SAVEPOINT ${name}`);
  let out: T;
  try {
    out = fn();
  } catch (primary) {
    try {
      db.exec(`ROLLBACK TO ${name}`);
      // RELEASE after ROLLBACK TO: the savepoint still exists after unwinding to it, and leaving it
      // on the stack would make a later RELEASE of an OUTER savepoint also discard this one.
      db.exec(`RELEASE ${name}`);
    } catch (rollbackErr) {
      attachRollbackError(primary, rollbackErr);
    }
    throw primary;
  }
  db.exec(`RELEASE ${name}`);
  return out;
}

/** SQLite's message when it has ALREADY rolled the transaction back for us (the common case for an
 *  I/O-class error). Distinguishing this from a genuine rollback failure is the whole point: the
 *  first is benign and expected, the second means the connection may still be INSIDE a transaction. */
const NO_ACTIVE_TXN = /no transaction is active|cannot rollback/i;

/** Attach a genuine rollback failure to the primary error without replacing it. Non-enumerable so
 *  it can never land in a JSON-serialized client response; read by the registry's diagnostics sink
 *  (THE-573) so an abandoned transaction reaches an operator, not only the caller. */
function attachRollbackError(primary: unknown, rollbackErr: unknown): void {
  if (NO_ACTIVE_TXN.test((rollbackErr as Error)?.message ?? "")) return; // benign, expected
  if (primary !== null && typeof primary === "object") {
    Object.defineProperty(primary, "rollbackError", {
      value: rollbackErr,
      enumerable: false,
      configurable: true,
    });
  }
}

/**
 * Roll back, attaching — never throwing — any genuine failure onto `primary`.
 *
 * Swallowing every rollback error (the obvious implementation) hides a real hazard: if `ROLLBACK`
 * fails while the transaction is still open, this connection is left in an abandoned transaction.
 * Later reads can then observe uncommitted rows, and the next `BEGIN` either fails or silently joins
 * the stale transaction. But throwing from here would replace `primary` — the error that actually
 * explains the failure — with a secondary one.
 *
 * So: report both. `primary` propagates unchanged, and a genuine rollback failure is attached as a
 * non-enumerable `rollbackError` property for the diagnostics sink to surface (non-enumerable so it
 * never lands in a JSON-serialized client response).
 */
function rollback(db: Database, primary: unknown): void {
  try {
    db.exec("ROLLBACK");
  } catch (rollbackErr) {
    attachRollbackError(primary, rollbackErr);
  }
}
