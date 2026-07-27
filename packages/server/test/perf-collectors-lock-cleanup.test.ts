// THE-458 regression guard: the lock probe's TEMP-DIR CLEANUP must never be able to fail the run.
//
// Its own file because `vi.mock` is hoisted per-module — the sibling suite needs a real `rmSync`.
//
// What happened: `rmSync` threw `EBUSY` on windows-latest even with both connections already
// closed, because Windows will not unlink a SQLite file whose WAL/shm mapping the OS still holds
// for a moment after close. That threw out of the collector, exited the perf-sample subprocess 1,
// and failed the whole isolate integration test. A temp-directory cleanup took down the
// measurement it existed to clean up after — and it did so ONLY on Windows, so Linux and macOS
// both reported green.
import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    // Exactly the Windows failure, deterministically, on every platform.
    rmSync: vi.fn(() => {
      const e = new Error("EBUSY: resource busy or locked, rm") as NodeJS.ErrnoException;
      e.code = "EBUSY";
      throw e;
    }),
  };
});

describe("collectLock — cleanup cannot fail the measurement (THE-458)", () => {
  it("still returns its metrics when temp-dir removal throws EBUSY", async () => {
    const { collectLock } = await import("../eval/perf/collectors/lock");
    const samples = await collectLock();

    // The measurement is unaffected: cleanup runs after every value is already computed.
    const by = new Map(samples.map((m) => [m.key, m]));
    expect(by.get("storage.lock_wait_observed")?.value).toBe(1);
    expect(by.get("storage.lock_busy_observed")?.value).toBe(1);

    // And the failure really was exercised — otherwise this passes because the mock never fired,
    // which is the same vacuous shape the gate itself exists to prevent.
    const { rmSync } = await import("node:fs");
    expect(vi.mocked(rmSync)).toHaveBeenCalled();
  }, 20_000);
});
