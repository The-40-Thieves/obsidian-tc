// THE-462 — unified background scheduler. One unref'd timer folds the four legacy setInterval
// timers (maintenance sweep, plane consolidation, activation recompute, contradiction drain) into
// a single tick loop with single-flight, budget deferral, durable last-success/next-run, backoff,
// and bounded cancellation. Scheduling is driven by the (fake) timer's own advancement — the
// injected `now()` is used ONLY for durable timestamps, so tests can pin it to a constant.
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/types";
import { Scheduler } from "../src/scheduler/scheduler";
import { openMemoryDb } from "./helpers";

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
});
