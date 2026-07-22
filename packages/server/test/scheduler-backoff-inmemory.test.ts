// THE-462 defect (a): the in-memory schedule never learned about an async failure.
//
// The tick loop set `state.nextRunAt` at DISPATCH time, before the promise settled. `onFailure`
// then incremented consecutiveFailures and wrote the backed-off `next_run_at` to job_schedule —
// but never revised the in-memory value. Result: backoff was durable and inert. A job failing
// every tick kept retrying at its BASE interval for the whole process lifetime, and the backoff
// only appeared after a restart re-seeded from the row. That is the exact opposite of what
// backoff is for: the failing case is when you least want retries at full rate.
//
// Backoff is exponential (intervalMs * 2^consecutiveFailures), so after one failure a job on a
// 1000ms interval must not run again until ~2000ms.
import { describe, expect, it, vi } from "vitest";
import { Scheduler } from "../src/scheduler/scheduler";

describe("THE-462(a): async failure backs off the in-memory schedule", () => {
  it("does not re-run at the base interval after an async rejection", async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      const sched = new Scheduler();
      sched.register({
        name: "always-fails",
        intervalMs: 1000,
        // Async rejection — the path that was broken. A synchronous throw was always handled.
        run: async () => {
          runs++;
          throw new Error("boom");
        },
        onError: () => {},
      });
      sched.start();

      // First run at t=1000 fails. With backoff the second must wait ~2000ms more (t≈3000),
      // so by t=2500 there must still be exactly one run.
      await vi.advanceTimersByTimeAsync(2500);

      expect(runs).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps stretching the interval as failures accumulate", async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      const sched = new Scheduler();
      sched.register({
        name: "always-fails",
        intervalMs: 1000,
        run: async () => {
          runs++;
          throw new Error("boom");
        },
        onError: () => {},
      });
      sched.start();

      // Un-backed-off, a 1000ms job would run ~15 times in 15s. With exponential backoff the
      // runs land at roughly t=1000, 3000, 7000, 15000 — a handful, not fifteen.
      await vi.advanceTimersByTimeAsync(15_000);

      expect(runs).toBeLessThanOrEqual(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns to the base interval once a run succeeds again", async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      let failNext = true;
      const sched = new Scheduler();
      sched.register({
        name: "recovers",
        intervalMs: 1000,
        run: async () => {
          runs++;
          if (failNext) {
            failNext = false;
            throw new Error("boom");
          }
        },
        onError: () => {},
      });
      sched.start();

      // t=1000 fails -> backoff to ~t=3000, which succeeds and resets consecutiveFailures.
      await vi.advanceTimersByTimeAsync(3500);
      const afterRecovery = runs;

      // Back on the base interval: the next second must produce another run.
      await vi.advanceTimersByTimeAsync(1200);

      expect(runs).toBeGreaterThan(afterRecovery);
    } finally {
      vi.useRealTimers();
    }
  });
});
