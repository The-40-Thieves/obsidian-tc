// THE-462 — unified background scheduler. One unref'd timer folds the four legacy setInterval
// timers (maintenance sweep, plane consolidation, activation recompute, contradiction drain) into
// a single tick loop with single-flight, budget deferral, durable last-success/next-run, backoff,
// and bounded cancellation. Scheduling is driven by the (fake) timer's own advancement — the
// injected `now()` is used ONLY for durable timestamps, so tests can pin it to a constant.

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/types";
import type { SchedulerPersistFailure } from "../src/scheduler/scheduler";
import { Scheduler } from "../src/scheduler/scheduler";
import { openMemoryDb } from "./helpers";

// THE-666: a REAL file-backed sqlite handle (not a stub) whose writes fail once the file's write
// bit is removed — node:sqlite falls back to read-only at open() time and every write then throws
// "attempt to write a readonly database". Loaded at runtime, same as helpers.ts's openMemoryDb, so
// Vite never statically resolves the node:sqlite builtin.
const req = createRequire(import.meta.url);
function openFileDb(dbPath: string): Database {
  const { DatabaseSync } = req("node:sqlite");
  return new DatabaseSync(dbPath) as Database;
}

// THE-666 review fix. Cleaning up a read-only sqlite file needs BOTH of these on Windows, and
// neither is required on POSIX — which is why this only ever failed on the windows-latest runner:
//
//   1. Restore the write bit. chmod 0o444 sets FILE_ATTRIBUTE_READONLY, and Windows refuses to
//      DELETE a read-only file (on POSIX the write bit governs writes, while the *directory's*
//      permissions govern unlink, so the file's own mode is irrelevant to rm).
//   2. CLOSE the open handle. Windows refuses to delete a file that is still open; POSIX happily
//      unlinks it and defers the inode's release. The tests below deliberately keep a handle open
//      to make writes fail, so it must be closed before removal, and closed even when an assertion
//      threw — hence the hoisted `db` and the `finally`.
//
// `fs.rmSync(..., { force: true })` fixes neither: `force` suppresses ENOENT, not EPERM. And a
// `finally` block's own throw REPLACES whatever the try block threw or returned, so leaving this
// broken could silently mask a genuine assertion failure behind an unrelated permissions error.
function cleanupReadOnlyDb(dir: string, dbPath: string, db?: Database): void {
  try {
    db?.close?.();
  } catch {
    /* already closed, or the handle never opened; removal is what matters */
  }
  try {
    fs.chmodSync(dbPath, 0o644);
  } catch {
    /* already gone, or was never made read-only on this platform; fall through regardless */
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("Scheduler (THE-462)", () => {
  it("runs a job on its interval and stop() halts further runs", async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      const sched = new Scheduler();
      sched.register({ name: "tick", intervalMs: 1000, run: () => void runs++ });
      sched.start();
      await vi.advanceTimersByTimeAsync(3500);
      expect(runs).toBe(3);
      await sched.stop();
      await vi.advanceTimersByTimeAsync(3000);
      expect(runs).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  // GATE 1 — single-flight: a still-in-flight run is never re-entered; onSkip fires with a
  // monotonic count for each due tick that was skipped.
  it("single-flight: does not re-enter a running job; onSkip increments", async () => {
    vi.useFakeTimers();
    try {
      let starts = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const skips: number[] = [];
      const sched = new Scheduler();
      sched.register({
        name: "hang",
        intervalMs: 1000,
        run: async () => {
          starts++;
          await gate; // hold the first run open across several ticks
        },
        onSkip: (n) => skips.push(n),
      });
      sched.start();
      await vi.advanceTimersByTimeAsync(3500); // tick@1000 starts; @2000,@3000 skip
      expect(starts).toBe(1);
      expect(skips).toEqual([1, 2]);
      release();
      await vi.advanceTimersByTimeAsync(1000); // run settled -> next tick re-enters
      expect(starts).toBe(2);
      await sched.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // GATE 2 — budget deferral: while the (injected) event-loop delay p99 exceeds the threshold,
  // due jobs are deferred (not run); once it drops they run.
  it("budget deferral: defers due jobs while loop delay is high, runs when it drops", async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      let loop = 500; // p99 ms, above the 100ms threshold
      const sched = new Scheduler({ eventLoopDeferMs: 100, loopDelayMs: () => loop });
      sched.register({ name: "j", intervalMs: 1000, run: () => void runs++ });
      sched.start();
      await vi.advanceTimersByTimeAsync(1000); // due, but deferred
      expect(runs).toBe(0);
      await vi.advanceTimersByTimeAsync(1000); // still high -> still deferred
      expect(runs).toBe(0);
      loop = 10; // p99 drops below threshold
      await vi.advanceTimersByTimeAsync(1000); // a recheck tick now runs it
      expect(runs).toBeGreaterThanOrEqual(1);
      await sched.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // THE-585 (#9) — deferred ticks accumulate on JobState/stats(), distinct from skipped (a
  // still-in-flight run) and consecutiveFailures (a run that threw). Drives the SAME budget-
  // deferral branch as GATE 2 above through the injectable loopDelayMs seam, then asserts the
  // stats() VALUE actually moved — a registered-but-unfed counter is the exact failure mode this
  // item exists to close (see the three dead gauges PR #474 fixed).
  it("budget deferral accumulates JobState.deferred, distinct from skipped/consecutiveFailures", async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      let loop = 500; // p99 ms, above the 100ms threshold
      const sched = new Scheduler({ eventLoopDeferMs: 100, loopDelayMs: () => loop });
      sched.register({ name: "j", intervalMs: 1000, run: () => void runs++ });
      sched.start();
      expect(sched.stats()[0]).toMatchObject({ job: "j", deferred: 0 });
      await vi.advanceTimersByTimeAsync(1000); // due, but deferred
      expect(runs).toBe(0);
      expect(sched.stats()[0]).toMatchObject({ job: "j", deferred: 1, skipped: 0 });
      await vi.advanceTimersByTimeAsync(250); // recheck tick, still high -> deferred again
      expect(sched.stats()[0]).toMatchObject({ job: "j", deferred: 2 });
      loop = 10; // p99 drops below threshold
      await vi.advanceTimersByTimeAsync(250); // a recheck tick now runs it
      expect(runs).toBe(1);
      expect(sched.stats()[0]).toMatchObject({ job: "j", deferred: 2, skipped: 0 }); // no more growth
      await sched.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // GATE 3 (success) — durable last-success + failure reset.
  it("durable: persists last_success_at and next_run_at, failures = 0 on success", async () => {
    vi.useFakeTimers();
    try {
      const db = openMemoryDb() as Database;
      const t = 1_000_000;
      const sched = new Scheduler({ db, now: () => t });
      sched.register({ name: "ok", intervalMs: 1000, run: () => {} });
      sched.start();
      await vi.advanceTimersByTimeAsync(1000);
      const row = db
        .prepare(
          "SELECT last_run_at, last_success_at, next_run_at, consecutive_failures FROM job_schedule WHERE name = ?",
        )
        .get("ok") as {
        last_run_at: number;
        last_success_at: number;
        next_run_at: number;
        consecutive_failures: number;
      };
      expect(row.last_success_at).toBe(t);
      expect(row.consecutive_failures).toBe(0);
      expect(row.next_run_at).toBe(t + 1000);
      await sched.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // GATE 3 (failure) — consecutive_failures increments and next_run reflects exponential backoff.
  it("durable: increments consecutive_failures and backs off next_run on failure", async () => {
    vi.useFakeTimers();
    try {
      const db = openMemoryDb() as Database;
      const t = 2_000_000;
      const errs: unknown[] = [];
      const sched = new Scheduler({ db, now: () => t, maxBackoffMs: 60_000 });
      sched.register({
        name: "bad",
        intervalMs: 1000,
        run: () => {
          throw new Error("boom");
        },
        onError: (e) => errs.push(e),
      });
      sched.start();
      await vi.advanceTimersByTimeAsync(1000);
      const row = db
        .prepare(
          "SELECT last_success_at, next_run_at, consecutive_failures FROM job_schedule WHERE name = ?",
        )
        .get("bad") as {
        last_success_at: number | null;
        next_run_at: number;
        consecutive_failures: number;
      };
      expect(errs).toHaveLength(1); // onError routed, never escaped
      expect(row.consecutive_failures).toBe(1);
      expect(row.last_success_at).toBeNull();
      expect(row.next_run_at).toBe(t + Math.min(1000 * 2 ** 1, 60_000)); // backoff = 2000ms
      await sched.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // Review fix (THE-462) — persistRunStart must actually persist last_run_at, and must never
  // clobber consecutive_failures back to 0/NULL on a mere run-start (that would defeat backoff).
  it("durable: last_run_at persists on run-start and run-start never resets consecutive_failures", async () => {
    vi.useFakeTimers();
    try {
      const db = openMemoryDb() as Database;
      let t = 4_000_000;
      let fail = true;
      const sched = new Scheduler({ db, now: () => t });
      sched.register({
        name: "flaky",
        intervalMs: 1000,
        run: () => {
          if (fail) throw new Error("boom");
        },
      });
      sched.start();

      // First run-start + failure: last_run_at must be set, consecutive_failures bumps to 1.
      await vi.advanceTimersByTimeAsync(1000);
      let row = db
        .prepare("SELECT last_run_at, consecutive_failures FROM job_schedule WHERE name = ?")
        .get("flaky") as { last_run_at: number | null; consecutive_failures: number };
      expect(row.last_run_at).toBe(t); // was always NULL before the fix
      expect(row.consecutive_failures).toBe(1);

      // Second run-start (still failing, backoff = 2000ms): the run-start persist that fires
      // BEFORE the run body executes must not reset the backoff counter to 0.
      t = 4_003_000;
      await vi.advanceTimersByTimeAsync(2000);
      row = db
        .prepare("SELECT last_run_at, consecutive_failures FROM job_schedule WHERE name = ?")
        .get("flaky") as { last_run_at: number | null; consecutive_failures: number };
      expect(row.last_run_at).toBe(t);
      expect(row.consecutive_failures).toBe(2); // preserved + incremented, never reset by run-start

      // A subsequent success resets consecutive_failures to 0, as onSuccess intends.
      fail = false;
      t = 4_010_000;
      await vi.advanceTimersByTimeAsync(4000); // next backoff = 1000*2^2 = 4000ms
      row = db
        .prepare("SELECT last_run_at, consecutive_failures FROM job_schedule WHERE name = ?")
        .get("flaky") as { last_run_at: number | null; consecutive_failures: number };
      expect(row.last_run_at).toBe(t);
      expect(row.consecutive_failures).toBe(0);

      await sched.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("seeds next_run from the stored value on start", async () => {
    vi.useFakeTimers();
    try {
      const db = openMemoryDb() as Database;
      // A pre-existing schedule row whose next_run_at is 5s out from `now`.
      const t = 3_000_000;
      db.exec(
        "CREATE TABLE IF NOT EXISTS job_schedule (name TEXT PRIMARY KEY, last_run_at INTEGER, last_success_at INTEGER, next_run_at INTEGER, consecutive_failures INTEGER NOT NULL DEFAULT 0)",
      );
      db.prepare(
        "INSERT INTO job_schedule (name, next_run_at, consecutive_failures) VALUES (?, ?, 0)",
      ).run("seeded", t + 5000);
      let runs = 0;
      const sched = new Scheduler({ db, now: () => t });
      sched.register({ name: "seeded", intervalMs: 1000, run: () => void runs++ });
      sched.start();
      await vi.advanceTimersByTimeAsync(1000); // < seeded 5s delay -> not yet
      expect(runs).toBe(0);
      await vi.advanceTimersByTimeAsync(4000); // reaches the seeded next_run
      expect(runs).toBe(1);
      await sched.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // Cancellation — stop() aborts the in-flight run's signal and resolves under a bounded deadline
  // even when the run never settles.
  it("stop() aborts the in-flight job's signal and resolves under the deadline", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const sched = new Scheduler({ shutdownDeadlineMs: 5000 });
      sched.register({
        name: "hang",
        intervalMs: 1000,
        run: (s) => {
          signal = s;
          return new Promise<void>(() => {}); // never settles
        },
      });
      sched.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(signal?.aborted).toBe(false);
      const stopP = sched.stop();
      expect(signal?.aborted).toBe(true); // abort is synchronous
      await vi.advanceTimersByTimeAsync(5000); // deadline elapses
      await expect(stopP).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("higher priority runs first when several jobs are due at once", async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const sched = new Scheduler();
      sched.register({
        name: "low",
        intervalMs: 1000,
        priority: 0,
        run: () => void order.push("low"),
      });
      sched.register({
        name: "high",
        intervalMs: 1000,
        priority: 10,
        run: () => void order.push("high"),
      });
      sched.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(order).toEqual(["high", "low"]);
      await sched.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an onError sink that throws never escapes the tick", async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      const sched = new Scheduler();
      sched.register({
        name: "boom",
        intervalMs: 1000,
        run: () => {
          runs++;
          throw new Error("kaboom");
        },
        onError: () => {
          throw new Error("sink also throws");
        },
      });
      sched.start();
      // Runs at t=1000 then, after failure backoff (1000*2^1), again at t=3000; neither the throw
      // nor the throwing onError sink escapes the tick.
      await vi.advanceTimersByTimeAsync(3500);
      expect(runs).toBe(2);
      await sched.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // THE-666 — durable persistence used to swallow every failure with no signal: ensureTable,
  // seedNextRun, persistRunStart, and persist all had a bare `catch {}`. These tests induce REAL
  // persistence failures (a read-only sqlite file, a dropped table) rather than stubbing an error,
  // and check both halves the ticket asks for: the signal fires, AND the scheduler keeps running.
  describe("durable persistence failure signal (THE-666)", () => {
    it("persistRunStart/persist failures on a real read-only db surface once each via onPersistError, and the job keeps running", async () => {
      vi.useFakeTimers();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "the666-persist-"));
      const dbPath = path.join(dir, "sched.db");
      let db: Database | undefined;
      try {
        // job_schedule already exists and is writable when created; only AFTER that does the file
        // lose its write bit, so every persistRunStart/persist call on the scheduler under test
        // hits a genuine "attempt to write a readonly database" — not a mocked error.
        const setup = openFileDb(dbPath);
        setup.exec(
          "CREATE TABLE IF NOT EXISTS job_schedule (name TEXT PRIMARY KEY, last_run_at INTEGER, last_success_at INTEGER, next_run_at INTEGER, consecutive_failures INTEGER NOT NULL DEFAULT 0)",
        );
        setup.close?.();
        fs.chmodSync(dbPath, 0o444);
        db = openFileDb(dbPath);

        const failures: SchedulerPersistFailure[] = [];
        let runs = 0;
        const sched = new Scheduler({
          db,
          now: () => 1_000_000,
          onPersistError: (f) => failures.push(f),
        });
        sched.register({ name: "j", intervalMs: 1000, run: () => void runs++ });
        sched.start();

        // Three due ticks. EVERY tick's persistRunStart (before the run) and persist (after the
        // run succeeds) fail — the constraint under test is that the job body still runs on every
        // one of them regardless.
        await vi.advanceTimersByTimeAsync(3500);
        expect(runs).toBe(3); // scheduling survives a wholly broken persistence layer

        const persistRunStartFailures = failures.filter((f) => f.op === "persistRunStart");
        const persistFailures = failures.filter((f) => f.op === "persist");
        // Watched failing: both ops genuinely failed 3 times each, but the signal is throttled to
        // ONE call per op — the job-queue-runner ticks every 15s in production, so an unthrottled
        // callback here would be an unbounded log flood.
        expect(persistRunStartFailures).toHaveLength(1);
        expect(persistFailures).toHaveLength(1);
        expect(persistRunStartFailures[0]?.job).toBe("j");
        expect(persistFailures[0]?.job).toBe("j");
        expect(String((persistRunStartFailures[0]?.error as Error)?.message)).toMatch(
          /readonly database/i,
        );

        await sched.stop();
      } finally {
        vi.useRealTimers();
        cleanupReadOnlyDb(dir, dbPath, db);
      }
    });

    it("ensureTable failure surfaces via onPersistError with no job, and scheduling still starts", async () => {
      vi.useFakeTimers();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "the666-ensuretable-"));
      const dbPath = path.join(dir, "sched.db");
      let db: Database | undefined;
      try {
        // Unlike the test above, job_schedule does NOT already exist — ensureTable's own
        // CREATE TABLE IF NOT EXISTS is the write that fails.
        const setup = openFileDb(dbPath);
        setup.exec("CREATE TABLE dummy (x INTEGER)");
        setup.close?.();
        fs.chmodSync(dbPath, 0o444);
        db = openFileDb(dbPath);

        const failures: SchedulerPersistFailure[] = [];
        const sched = new Scheduler({
          db,
          now: () => 2_000_000,
          onPersistError: (f) => failures.push(f),
        });
        // ensureTable runs synchronously inside the constructor, before any job is registered.
        const ensureTableFailures = failures.filter((f) => f.op === "ensureTable");
        expect(ensureTableFailures).toHaveLength(1);
        expect(ensureTableFailures[0]?.job).toBeUndefined();

        let runs = 0;
        sched.register({ name: "k", intervalMs: 1000, run: () => void runs++ });
        sched.start();
        await vi.advanceTimersByTimeAsync(3000);
        expect(runs).toBe(3); // job_schedule was NEVER created; scheduling is unaffected regardless

        await sched.stop();
      } finally {
        vi.useRealTimers();
        cleanupReadOnlyDb(dir, dbPath, db);
      }
    });

    it("seedNextRun: a legitimate missing row emits no signal (fresh install, not a failure)", async () => {
      vi.useFakeTimers();
      try {
        const db = openMemoryDb() as Database;
        const failures: SchedulerPersistFailure[] = [];
        const sched = new Scheduler({
          db,
          now: () => 3_000_000,
          onPersistError: (f) => failures.push(f),
        });
        sched.register({ name: "fresh", intervalMs: 1000, run: () => {} });
        sched.start(); // job_schedule exists (ensureTable) but has no row for "fresh"
        expect(failures).toHaveLength(0);
        await sched.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("seedNextRun: a real read failure (dropped table) surfaces via onPersistError, and scheduling still starts", async () => {
      vi.useFakeTimers();
      try {
        const db = openMemoryDb() as Database;
        const failures: SchedulerPersistFailure[] = [];
        const sched = new Scheduler({
          db,
          now: () => 3_000_000,
          onPersistError: (f) => failures.push(f),
        });
        // A genuine read failure, not a stub — the table ensureTable just created is gone by the
        // time start() calls seedNextRun's SELECT.
        db.exec("DROP TABLE job_schedule");

        let runs = 0;
        sched.register({ name: "j2", intervalMs: 1000, run: () => void runs++ });
        sched.start();

        const seedFailures = failures.filter((f) => f.op === "seedNextRun");
        expect(seedFailures).toHaveLength(1);
        expect(seedFailures[0]?.job).toBe("j2");
        expect(String((seedFailures[0]?.error as Error)?.message)).toMatch(/no such table/i);

        // Falls back to a fresh schedule exactly like a legitimate "no row" would — the read
        // failure is distinguishable from OUTSIDE the process (via onPersistError above), but it
        // does not change in-process scheduling behaviour.
        await vi.advanceTimersByTimeAsync(1000);
        expect(runs).toBe(1);

        await sched.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a persist failure that recovers alerts again on a later failure, not just the first (throttle resets on success)", async () => {
      vi.useFakeTimers();
      try {
        // A controlled fake, isolating the dedup-reset transition itself — the tests above already
        // prove the signal fires on genuine sqlite I/O errors; a real file handle can't cleanly
        // model "recovers mid-connection" since node:sqlite decides read-only fallback at open()
        // time (verified: chmod'ing the file writable again does not un-stick an already-open
        // handle).
        const real = openMemoryDb();
        let failing = false;
        const db: Database = {
          exec: (sql) => real.exec(sql),
          prepare: (sql) => {
            const stmt = real.prepare(sql);
            return {
              get: (...args: unknown[]) => stmt.get(...args),
              all: (...args: unknown[]) => stmt.all(...args),
              run: (...args: unknown[]) => {
                if (failing) throw new Error("injected: db unavailable");
                return stmt.run(...args);
              },
            };
          },
        };

        const failures: SchedulerPersistFailure[] = [];
        let runs = 0;
        const sched = new Scheduler({
          db,
          now: () => 4_000_000,
          onPersistError: (f) => failures.push(f),
        });
        sched.register({ name: "flap", intervalMs: 1000, run: () => void runs++ });
        sched.start();

        failing = true;
        await vi.advanceTimersByTimeAsync(1000); // tick 1: fails, alerts once
        expect(failures.filter((f) => f.op === "persistRunStart")).toHaveLength(1);

        failing = false;
        await vi.advanceTimersByTimeAsync(1000); // tick 2: recovers, clears the dedup key

        failing = true;
        await vi.advanceTimersByTimeAsync(1000); // tick 3: fails again -> a NEW streak, alerts again
        expect(failures.filter((f) => f.op === "persistRunStart")).toHaveLength(2);
        expect(runs).toBe(3); // the job body ran on every tick throughout

        await sched.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
