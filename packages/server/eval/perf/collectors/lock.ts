// THE-458 perf gate — SQLite write-lock contention. The one gate the program's item list named as
// missing that had no ticket of its own.
//
// ## What this is NOT
//
// It is not a discovery instrument. `inWriteTransaction` (src/db/txn.ts) already measures lock wait
// correctly in production and feeds `obsidian_tc_sql_lock_wait_seconds`. What was missing is anything
// that ever WATCHES that instrument fire. A histogram nobody has seen produce a non-zero sample is
// indistinguishable from an uncontended system — and on this project three separate layers were
// independently zeroing it (an image predating the metric, `prometheus.enabled` defaulting false, and
// a scrape config with no targets), each of which looks exactly like "no contention" from outside.
//
// So the load-bearing metric here is `storage.lock_wait_observed`: proof the instrument reports a
// non-zero wait when a wait genuinely happened.
//
// ## Why this needs its own database
//
// The harness's vault runs on `:memory:`, where every connection is a SEPARATE database — there is no
// lock to contend for. Contention requires two connections to one FILE, so this opens its own temp
// db. That makes it a microbenchmark, like `storage.txn_*` beside it, and it is labelled as one.
//
// ## Why no concurrency is needed
//
// SQLite's write lock is held by CONNECTION STATE, not by executing code. A connection that runs
// `BEGIN IMMEDIATE` and simply does not commit holds the lock while the thread goes on to do other
// things. So a single-threaded probe produces real writer-vs-writer contention with no subprocess,
// no worker, and no timing race:
//
//     B: BEGIN IMMEDIATE; INSERT            -> B holds the write lock, and keeps holding it
//     A: inWriteTransaction(...)            -> A's BEGIN IMMEDIATE blocks for busy_timeout, throws
//
// Under WAL readers never block, so this is deliberately writer-vs-writer — the only shape the
// metric can see, and the exact question THE-467/468 are gated on.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../../src/db/open";
import { inWriteTransaction, type WriteTxnLabel } from "../../../src/db/txn";
import type { MetricSample } from "../report";

/**
 * How long A is willing to wait before giving up.
 *
 * Deliberately short: this is a deterministic probe, and the number only has to be far enough above
 * timer noise to be unambiguous. It is ALSO the value the measured wait is compared against, and a
 * SQLite busy timeout consistently overshoots itself — measured 200→201.5ms, 1000→1003.8ms,
 * 5000→5006.1ms. So the assertion below is `>=`, never `==`, and a bucket at exactly the timeout
 * could never contain a timed-out acquisition. Production's histogram has the same property, which
 * is why its top bucket sits at 10s against a 5s timeout.
 */
const BUSY_TIMEOUT_MS = 250;

/** A real label from the production union, so this exercises the same call shape as index writes. */
const PROBE_LABEL: WriteTxnLabel = "index_batch";

export async function collectLock(): Promise<MetricSample[]> {
  const dir = mkdtempSync(join(tmpdir(), "tc-perf-lock-"));
  const file = join(dir, "lock-probe.db");

  // Two connections to ONE file. `:memory:` would give two unrelated databases and measure nothing.
  const holder = await openDatabase(file);
  const waiter = await openDatabase(file);
  let observedSeconds = 0;
  let busyFired = 0;
  let threw = 0;

  try {
    holder.exec("PRAGMA journal_mode = WAL");
    holder.exec("CREATE TABLE IF NOT EXISTS probe (k INTEGER PRIMARY KEY, v TEXT)");
    waiter.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);

    // Take the write lock and DO NOT commit. The lock lives on the connection, so control returns
    // here with it still held.
    holder.exec("BEGIN IMMEDIATE");
    holder.prepare("INSERT INTO probe (k, v) VALUES (?, ?)").run(1, "held");

    // The measurement. This is the PRODUCTION function, not a reimplementation of it — the whole
    // point is to exercise the instrument that ships.
    try {
      inWriteTransaction(
        waiter,
        PROBE_LABEL,
        () => {
          // Never reached while the holder keeps the lock. If it ever is, the floor below fails and
          // says so, rather than this silently becoming a no-contention benchmark.
          waiter.prepare("INSERT INTO probe (k, v) VALUES (?, ?)").run(2, "waiter");
        },
        {
          onLockWait: (_label, seconds) => {
            observedSeconds = seconds;
          },
          onBusy: () => {
            busyFired += 1;
          },
        },
      );
    } catch {
      // Expected: acquisition times out and throws SQLITE_BUSY. The instrument records the wait on
      // this path too — deliberately, because a timed-out acquisition is the LONGEST wait there is
      // and dropping it would bias the histogram toward fast acquisitions exactly when contention
      // is worst.
      threw = 1;
    }

    holder.exec("COMMIT");
  } finally {
    holder.close?.();
    waiter.close?.();
    rmSync(dir, { recursive: true, force: true });
  }

  const waitMs = observedSeconds * 1000;

  return [
    {
      // THE load-bearing one. Hard-class and deterministic: under a held lock the instrument MUST
      // report a non-zero wait. A 0 here means the instrument stopped working, the probe stopped
      // contending, or someone converted the write path back to a deferred BEGIN (which takes no
      // lock and would report ~0 forever while looking healthy).
      key: "storage.lock_wait_observed",
      value: observedSeconds > 0 ? 1 : 0,
      unit: "bool",
      class: "hard",
      direction: "lower-worse",
    },
    {
      // Also hard: the acquisition must actually FAIL under a held lock. If this goes to 0 the probe
      // is no longer contending, and `lock_wait_observed` alone could still pass on a fast
      // uncontended acquisition.
      key: "storage.lock_busy_observed",
      value: busyFired > 0 && threw === 1 ? 1 : 0,
      unit: "bool",
      class: "hard",
      direction: "lower-worse",
    },
    {
      // Wall-clock, so warn-class like every other timing figure in this harness. Its value is the
      // shape, not the number: it should sit at or just above busy_timeout, never below it.
      key: "storage.lock_wait_ms",
      value: Number(waitMs.toFixed(2)),
      unit: "ms",
      class: "warn",
      direction: "higher-worse",
    },
    {
      // The overshoot property as an assertion. A timeout measures OVER its own value, so a wait
      // BELOW the timeout means the probe returned early — i.e. it never really waited.
      key: "storage.lock_wait_at_least_timeout",
      value: waitMs >= BUSY_TIMEOUT_MS ? 1 : 0,
      unit: "bool",
      class: "hard",
      direction: "lower-worse",
    },
  ];
}
