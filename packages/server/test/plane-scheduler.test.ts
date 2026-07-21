// THE-296 — plane scheduler: ticks, reports, stops, contains failures.
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/types";
import { type JobResult, registerPlaneScheduler, SleepTimePlane } from "../src/plane/plane";
import { Scheduler } from "../src/scheduler/scheduler";

const stubDb = {
  prepare() {
    return { get: () => undefined, run: () => ({ changes: 0 }), all: () => [] };
  },
  exec() {},
} as unknown as Database;

describe("plane scheduler (THE-296)", () => {
  it("runs registered jobs on the interval and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      const plane = new SleepTimePlane().register({
        name: "counting",
        run: async () => {
          runs++;
          return { ok: true };
        },
      });
      const seen: Array<Record<string, JobResult>> = [];
      const sched = new Scheduler();
      registerPlaneScheduler(sched, plane, {
        db: stubDb,
        roles: null,
        intervalMs: 1000,
        now: () => 5_000_000,
        onRun: (r) => seen.push(r),
      });
      sched.start();
      await vi.advanceTimersByTimeAsync(3500);
      expect(runs).toBe(3);
      await sched.stop();
      await vi.advanceTimersByTimeAsync(2000);
      expect(runs).toBe(3);
      expect(seen[0]?.counting?.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a throwing job is contained by the plane (ok:false), never escaping the timer", async () => {
    vi.useFakeTimers();
    try {
      const plane = new SleepTimePlane().register({
        name: "boom",
        run: async () => {
          throw new Error("job exploded");
        },
      });
      const seen: Array<Record<string, JobResult>> = [];
      const sched = new Scheduler();
      registerPlaneScheduler(sched, plane, {
        db: stubDb,
        roles: null,
        intervalMs: 1000,
        now: () => 5_000_000,
        onRun: (r) => seen.push(r),
      });
      sched.start();
      await vi.advanceTimersByTimeAsync(1100);
      expect(seen[0]?.boom?.ok).toBe(false);
      await sched.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips overlapping ticks while a slow run is still in flight (single-flight, THE-457)", async () => {
    vi.useFakeTimers();
    try {
      let active = 0;
      let maxConcurrent = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let firstRun = true;
      const plane = new SleepTimePlane().register({
        name: "slow",
        run: async () => {
          active++;
          maxConcurrent = Math.max(maxConcurrent, active);
          if (firstRun) {
            firstRun = false;
            await gate; // hold the first run open across several ticks
          }
          active--;
          return { ok: true };
        },
      });
      const skips: number[] = [];
      const sched = new Scheduler();
      registerPlaneScheduler(sched, plane, {
        db: stubDb,
        roles: null,
        intervalMs: 1000,
        now: () => 5_000_000,
        onSkip: (n) => skips.push(n),
      });
      sched.start();
      // Tick 1 starts the slow run; ticks 2 and 3 fire while it is still in flight.
      await vi.advanceTimersByTimeAsync(3500);
      expect(skips.length).toBeGreaterThanOrEqual(2); // overlapping ticks were skipped, not run
      expect(skips.at(-1)).toBe(skips.length); // monotonic skip counter
      release(); // let the first run complete
      await vi.advanceTimersByTimeAsync(1);
      expect(maxConcurrent).toBe(1); // runAll never overlapped itself
      await sched.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("plane config defaults are fully-defaulted (pre-THE-296 configs validate unchanged)", () => {
    const c = ServerConfigSchema.parse({ vaults: [{ id: "v", path: "/v" }] });
    expect(c.plane).toEqual({ enabled: true, intervalMinutes: 240 });
  });
});
