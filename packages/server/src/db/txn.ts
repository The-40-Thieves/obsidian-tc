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

/**
 * THE-585 (#5): the WRITE counterpart to `inTransaction`, and the only shape a SQL lock wait can
 * be measured at.
 *
 * ## Why `BEGIN IMMEDIATE` rather than `BEGIN`
 *
 * A deferred `BEGIN` takes NO lock — it returns instantly even while another connection holds the
 * write lock, and the wait lands on the transaction's first write STATEMENT instead. Timing a
 * deferred `BEGIN` therefore measures nothing at all: probed against a held lock, `BEGIN` returned
 * in 0.0 ms and the following `INSERT` took 529.6 ms. `BEGIN IMMEDIATE` acquires the write lock up
 * front, so its own duration IS the lock wait, cleanly separated from the work.
 *
 * The mode change is not merely instrumentation. A deferred transaction that READS and then writes
 * is exposed to a failure `busy_timeout` cannot absorb: once another connection commits, the
 * upgrade fails with `SQLITE_BUSY_SNAPSHOT` **immediately** (measured: 0.2 ms against a 5000 ms
 * busy_timeout), because SQLite will not retry an upgrade that could deadlock. `BEGIN IMMEDIATE`
 * never takes that path — it either waits out the timeout or fails cleanly with plain
 * `SQLITE_BUSY`. So every read-then-write transaction is strictly safer here.
 *
 * Under WAL, readers never block, so this is purely a writer-vs-writer signal — which is exactly
 * the question THE-467/468 (per-vault storage isolation) has to answer.
 *
 * Rollback discipline, `BEGIN` placement, and re-entrancy match `inTransaction` exactly; see there.
 * The hooks are observability and are best-effort by contract: a throwing metrics sink must never
 * turn a committed transaction into a failed one.
 */
export function inWriteTransaction<T>(
  db: Database,
  label: WriteTxnLabel,
  fn: () => T,
  hooks?: WriteTxnHooks,
): T {
  const started = performance.now();
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (beginErr) {
    // Record the wait even though acquisition FAILED. A busy timeout is the longest wait there is,
    // and dropping those samples would bias the histogram toward fast acquisitions at exactly the
    // moment contention is worst — the opposite of what the metric exists to show.
    notify(hooks?.onLockWait, label, (performance.now() - started) / 1000);
    reportBusy(hooks, label, beginErr);
    throw beginErr; // no transaction was opened by us — nothing to roll back (see inTransaction)
  }
  notify(hooks?.onLockWait, label, (performance.now() - started) / 1000);

  let out: T;
  try {
    out = fn();
  } catch (primary) {
    reportBusy(hooks, label, primary);
    rollback(db, primary);
    throw primary;
  }
  try {
    db.exec("COMMIT");
  } catch (commitErr) {
    reportBusy(hooks, label, commitErr);
    rollback(db, commitErr);
    throw commitErr;
  }
  return out;
}

/** Which write transaction a lock-wait sample came from. A closed union, not a free string: it
 *  becomes a Prometheus label, and THE-585's cardinality rule admits only bounded values. Adding a
 *  member here is the ONLY way to add a series, so the label set cannot drift open by accident. */
export type WriteTxnLabel =
  // THE-694/695: the lazy build and LRU eviction of a caller's permitted-path set. A WRITE issued
  // from a READ path, so its lock-wait profile is worth its own series — it is the one write that
  // contends with interactive dispatch by design.
  | "acl_path_set"
  | "index_batch"
  | "index_note"
  | "index_deindex"
  | "index_notes_flush"
  // THE-934 fix round 4 (2): the reconcile walk's note_summaries prune for notes under
  // egress.excludePaths. Its own series rather than folded into index_notes_flush: it runs only on
  // a vault that CONFIGURES an exclusion, and it is the one index-pass write whose absence is a
  // security signal, so an operator watching lock waits should be able to see it separately.
  | "index_egress_summaries"
  | "index_generation"
  | "job_claim"
  | "memory_observation"
  // THE-726: the task-verdict projection. One label for the stamp AND the -1 demotion, because
  // they are one transaction by requirement: a crash between them would leave a session's episodes
  // condemned but still promoted, which is exactly the hold-rule bypass the demotion exists to
  // close.
  | "task_verdict";

/** Busy-class outcomes, split because they mean different things operationally: `busy` is
 *  contention that outlived `busy_timeout` (tune the timeout, or reduce writer overlap), while
 *  `snapshot` is an unrescuable deferred-upgrade failure that means a write path is STILL using
 *  `BEGIN` where it should use `inWriteTransaction`. A non-zero `snapshot` count is a bug report. */
export type BusyReason = "busy" | "snapshot";

export interface WriteTxnHooks {
  /** Seconds spent acquiring the write lock. Fires on every attempt, successful or not. */
  onLockWait?: (label: WriteTxnLabel, seconds: number) => void;
  /** A busy-class failure. Fires IN ADDITION to onLockWait, and the error still propagates. */
  onBusy?: (label: WriteTxnLabel, reason: BusyReason) => void;
}

/** SQLite's primary result code for a busy database. Extended codes keep it in the low byte
 *  (`SQLITE_BUSY_RECOVERY` 261, `SQLITE_BUSY_SNAPSHOT` 517, `SQLITE_BUSY_TIMEOUT` 773), which is
 *  why the numeric test masks rather than compares. */
const SQLITE_BUSY = 5;
const SQLITE_BUSY_SNAPSHOT = 517;

/**
 * Classify a busy-class SQLite error across all three adapters, or null if it is not one.
 *
 * Both discriminators are needed — verified by probing each adapter directly:
 *
 * | adapter        | plain busy                       | snapshot                                  |
 * | -------------- | -------------------------------- | ----------------------------------------- |
 * | bun:sqlite     | `code:"SQLITE_BUSY"`, `errno:5`  | `code:"SQLITE_BUSY_SNAPSHOT"`, `errno:517`|
 * | better-sqlite3 | `code:"SQLITE_BUSY"`             | `code:"SQLITE_BUSY_SNAPSHOT"`             |
 * | node:sqlite    | `code:"ERR_SQLITE_ERROR"`, `errcode:5` | `code:"ERR_SQLITE_ERROR"`, `errcode:517` |
 *
 * `node:sqlite` collapses every error to the generic `ERR_SQLITE_ERROR`, so the string test alone
 * would never fire on the test path OR in the .mcpb bundle, which is what it ships. better-sqlite3
 * carries no numeric code at all, so the numeric test alone would never fire in Node production.
 * `message` is byte-identical ("database is locked") on all three, so it cannot classify anything.
 */
export function busyReason(err: unknown): BusyReason | null {
  if (err === null || typeof err !== "object") return null;
  const e = err as { code?: unknown; errcode?: unknown; errno?: unknown };
  if (typeof e.code === "string" && e.code.startsWith("SQLITE_BUSY")) {
    return e.code === "SQLITE_BUSY_SNAPSHOT" ? "snapshot" : "busy";
  }
  const numeric =
    typeof e.errcode === "number" ? e.errcode : typeof e.errno === "number" ? e.errno : null;
  if (numeric === null || (numeric & 0xff) !== SQLITE_BUSY) return null;
  return numeric === SQLITE_BUSY_SNAPSHOT ? "snapshot" : "busy";
}

function reportBusy(hooks: WriteTxnHooks | undefined, label: WriteTxnLabel, err: unknown): void {
  const reason = busyReason(err);
  if (reason) notify(hooks?.onBusy, label, reason);
}

/** Fire an observability hook without letting it affect the transaction — the same best-effort
 *  contract semanticSearch's `onFallback`, retrievalLog, and the audit writer carry. */
function notify<A>(
  hook: ((label: WriteTxnLabel, arg: A) => void) | undefined,
  label: WriteTxnLabel,
  arg: A,
): void {
  try {
    hook?.(label, arg);
  } catch {
    /* observability is never load-bearing */
  }
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
