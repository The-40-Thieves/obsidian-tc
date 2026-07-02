// THE-296 — plane scheduler: ticks, reports, stops, contains failures.
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/types";
import { type JobResult, SleepTimePlane, startPlaneScheduler } from "../src/plane/plane";

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
      const stop = startPlaneScheduler(plane, {
        db: stubDb,
        roles: null,
        intervalMs: 1000,
        now: () => 5_000_000,
        onRun: (r) => seen.push(r),
      });
      await vi.advanceTimersByTimeAsync(3500);
      expect(runs).toBe(3);
      stop();
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
      const stop = startPlaneScheduler(plane, {
        db: stubDb,
        roles: null,
        intervalMs: 1000,
        now: () => 5_000_000,
        onRun: (r) => seen.push(r),
      });
      await vi.advanceTimersByTimeAsync(1100);
      expect(seen[0]?.boom?.ok).toBe(false);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("plane config defaults are fully-defaulted (pre-THE-296 configs validate unchanged)", () => {
    const c = ServerConfigSchema.parse({ vaults: [{ id: "v", path: "/v" }] });
    expect(c.plane).toEqual({ enabled: true, intervalMinutes: 240 });
  });
});
