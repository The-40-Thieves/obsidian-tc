// Unit tests for the generic bulk executor (THE-182). Locks the partial-failure
// contract: best-effort-continue by default (every item attempted, per-item report
// with ok/error and stable identity), stop-on-first-error halts the queue, and a
// concurrency cap bounds in-flight sub-ops. No vault, no IO — pure orchestration.
import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { runBulk } from "../src/vault/bulk";

const id = (item: { path: string }) => ({ path: item.path });

describe("runBulk — best-effort (default)", () => {
  it("attempts every item and reports per-item ok/error with identity", async () => {
    const items = [{ path: "a" }, { path: "b" }, { path: "c" }];
    const report = await runBulk(
      items,
      { maxConcurrent: 4, stopOnFirstError: false },
      id,
      (item) => {
        if (item.path === "b") throw new ObsidianTcError("note_not_found", "missing b");
        return { wrote: item.path };
      },
    );
    expect(report.processed).toBe(3);
    expect(report.succeeded).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.results.map((r) => r.path)).toEqual(["a", "b", "c"]); // order preserved
    expect(report.results[0]).toMatchObject({ path: "a", ok: true, wrote: "a" });
    expect(report.results[1]).toMatchObject({ path: "b", ok: false });
    expect((report.results[1] as { error: { code: string } }).error.code).toBe("note_not_found");
    expect(report.results[2]).toMatchObject({ path: "c", ok: true, wrote: "c" });
  });

  it("wraps a non-ObsidianTcError as internal_error", async () => {
    const report = await runBulk(
      [{ path: "x" }],
      { maxConcurrent: 1, stopOnFirstError: false },
      id,
      () => {
        throw new Error("boom");
      },
    );
    expect(report.failed).toBe(1);
    expect((report.results[0] as { error: { code: string } }).error.code).toBe("internal_error");
  });
});

describe("runBulk — stop_on_first_error", () => {
  it("halts the queue at the first failure (sequential)", async () => {
    const attempted: string[] = [];
    const report = await runBulk(
      [{ path: "a" }, { path: "b" }, { path: "c" }],
      { maxConcurrent: 1, stopOnFirstError: true },
      id,
      (item) => {
        attempted.push(item.path);
        if (item.path === "b") throw new ObsidianTcError("note_not_found", "missing b");
        return { wrote: item.path };
      },
    );
    expect(attempted).toEqual(["a", "b"]); // c never attempted
    expect(report.processed).toBe(2);
    expect(report.succeeded).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.results).toHaveLength(2);
  });
});

describe("runBulk — concurrency cap", () => {
  it("never runs more than maxConcurrent sub-ops at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 6 }, (_, i) => ({ path: `n${i}` }));
    await runBulk(items, { maxConcurrent: 2, stopOnFirstError: false }, id, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight--;
      return {};
    });
    expect(maxInFlight).toBe(2);
  });

  it("runs sequentially when maxConcurrent is 1", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 4 }, (_, i) => ({ path: `n${i}` }));
    await runBulk(items, { maxConcurrent: 1, stopOnFirstError: false }, id, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      return {};
    });
    expect(maxInFlight).toBe(1);
  });
});

describe("runBulk — edges", () => {
  it("returns an empty report for no items", async () => {
    const report = await runBulk(
      [] as { path: string }[],
      { maxConcurrent: 4, stopOnFirstError: false },
      id,
      () => ({}),
    );
    expect(report).toMatchObject({ processed: 0, succeeded: 0, failed: 0, results: [] });
  });

  it("computes duration_ms from the injected clock", async () => {
    let t = 1000;
    const report = await runBulk(
      [{ path: "a" }],
      {
        maxConcurrent: 1,
        stopOnFirstError: false,
        now: () => {
          const v = t;
          t += 500;
          return v;
        },
      },
      id,
      () => ({}),
    );
    expect(report.duration_ms).toBe(500);
  });
});
