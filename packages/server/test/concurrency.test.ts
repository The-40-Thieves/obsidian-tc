// THE-448: bounded-concurrency helper for the multi-query fan-out (graphSearch has no built-in
// concept of running N variant queries in parallel, and the repo has no existing bounded-
// concurrency primitive — IndexCoordinator's concurrency in cli.ts/index_coordinator.ts serializes
// per-(vault,path) WRITES, a different problem). Proves: order preservation regardless of
// completion order, the concurrency cap is actually enforced (not silently serialized), the
// empty-input no-op, and that a thrown error propagates (callers are responsible for catching
// per-item failures — see multi_query.ts, which wraps each graphSearch call itself).
import { describe, expect, it } from "vitest";
import { runWithConcurrency } from "../src/util/concurrency";

describe("runWithConcurrency", () => {
  it("runs every item and preserves result order regardless of completion order", async () => {
    const items = [30, 5, 20, 10];
    const results = await runWithConcurrency(items, 2, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms * 2;
    });
    expect(results).toEqual(items.map((ms) => ms * 2));
  });

  it("never runs more than `limit` items concurrently", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    let inFlight = 0;
    let maxInFlight = 0;
    await runWithConcurrency(items, 3, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return i;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1); // proves real overlap, not accidental serialization
  });

  it("caps an out-of-range limit to at least 1 and at most the item count", async () => {
    const items = [1, 2];
    let maxInFlight = 0;
    let inFlight = 0;
    await runWithConcurrency(items, 0, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return i;
    });
    expect(maxInFlight).toBeGreaterThanOrEqual(1);
  });

  it("returns [] for an empty item list without invoking fn", async () => {
    let calls = 0;
    const results = await runWithConcurrency<number, number>([], 3, async (i) => {
      calls++;
      return i;
    });
    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });

  it("propagates a thrown error from fn (caller owns per-item error handling)", async () => {
    await expect(
      runWithConcurrency([1, 2, 3], 2, async (i) => {
        if (i === 2) throw new Error("boom");
        return i;
      }),
    ).rejects.toThrow("boom");
  });
});
