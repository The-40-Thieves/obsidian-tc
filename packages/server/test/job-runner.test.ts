import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { CACHE_MIGRATIONS } from "../src/db/provision";
import { JobQueue } from "../src/scheduler/job-queue";
import { type JobHandler, makeJobRunner } from "../src/scheduler/job-runner";
import { openMemoryDb } from "./helpers";

function setup(now = { t: 1000 }) {
  const db = openMemoryDb();
  runMigrations(db, CACHE_MIGRATIONS);
  const queue = new JobQueue(db, { now: () => now.t, leaseMs: 30_000, maxAttempts: 2 });
  return { db, queue };
}
const never = new AbortController().signal;

describe("makeJobRunner.drainOnce", () => {
  it("claims and dispatches each queued job to its type handler, then completes it", async () => {
    const { queue } = setup();
    const seen: string[] = [];
    const handlers = new Map<string, JobHandler>([
      [
        "a",
        async (job) => {
          seen.push(`a:${(job.payload as { v: string }).v}`);
        },
      ],
    ]);
    queue.enqueue("a", { idempotencyKey: "1", payload: { v: "x" } });
    queue.enqueue("a", { idempotencyKey: "2", payload: { v: "y" } });
    const runner = makeJobRunner({ queue, leaseOwner: "w", handlers });
    await runner.drainOnce(never);
    expect(seen.sort()).toEqual(["a:x", "a:y"]);
    expect(queue.stats().complete).toBe(2);
    expect(queue.stats().queued).toBe(0);
  });

  it("retries a throwing handler below maxAttempts, then dead-letters at the ceiling", async () => {
    const now = { t: 1000 };
    const { queue } = ((): ReturnType<typeof setup> => setup(now))();
    const handlers = new Map<string, JobHandler>([
      [
        "boom",
        async () => {
          throw new Error("nope");
        },
      ],
    ]);
    queue.enqueue("boom", { idempotencyKey: "1", maxAttempts: 2 });
    const runner = makeJobRunner({ queue, leaseOwner: "w", handlers });
    await runner.drainOnce(never);
    expect(queue.stats().retrying).toBe(1); // attempt 1 failed -> retrying
    now.t += 10 * 60_000; // past backoff so it is due again
    await runner.drainOnce(never);
    expect(queue.stats().failed).toBe(1); // attempt 2 (== maxAttempts) -> dead-letter
  });

  it("bounds work per tick to maxPerTick", async () => {
    const { queue } = setup();
    let ran = 0;
    const handlers = new Map<string, JobHandler>([
      [
        "a",
        async () => {
          ran++;
        },
      ],
    ]);
    for (let i = 0; i < 5; i++) queue.enqueue("a", { idempotencyKey: String(i) });
    const runner = makeJobRunner({ queue, leaseOwner: "w", handlers, maxPerTick: 2 });
    await runner.drainOnce(never);
    expect(ran).toBe(2);
  });

  it("dead-letters a claimed job whose type has no registered handler", async () => {
    // `types` is captured once, at makeJobRunner-construction time, from `handlers.keys()`.
    // JobQueue.claim's type filter is exact (`type IN (...)`) — a type absent from `types` can
    // never be claimed at all (verified directly against JobQueue: claim({ types: ["known"] })
    // returns null for a queued "unknown"-type job). So the only way a *claimed* job can lack a
    // handler is a handler deregistered from the live Map after construction but before this
    // tick — the exact "no handler for job type" branch in drainOnce. Model that here: "gone" is
    // present at construction (so `types` includes it, and the guard from item 1 does not fire),
    // then removed from the Map before drainOnce runs.
    const { queue } = setup();
    const outcomes: Array<[string, string]> = [];
    const handlers = new Map<string, JobHandler>([
      ["known", async () => {}],
      ["gone", async () => {}],
    ]);
    queue.enqueue("gone", { idempotencyKey: "1" });
    const runner = makeJobRunner({
      queue,
      leaseOwner: "w",
      handlers,
      onOutcome: (type, outcome) => outcomes.push([type, outcome]),
    });
    handlers.delete("gone"); // deregistered after construction, before the tick claims it
    await runner.drainOnce(never);
    expect(queue.stats().failed).toBe(1);
    expect(queue.stats().queued).toBe(0);
    expect(outcomes).toEqual([["gone", "failed"]]);
  });

  it("is a no-op with zero handlers, instead of claiming and dead-lettering every job", async () => {
    // Regression: `types` is `[...handlers.keys()]`; an empty map -> `types: []`. JobQueue.claim
    // gates its type filter on `opts.types?.length`, and `[].length === 0` is falsy -> treated as
    // "no filter" -> without the guard, a zero-handler runner would claim jobs of EVERY type and
    // terminally dead-letter them all.
    const { queue } = setup();
    queue.enqueue("a", { idempotencyKey: "1" });
    queue.enqueue("b", { idempotencyKey: "2" });
    const runner = makeJobRunner({ queue, leaseOwner: "w", handlers: new Map() });
    await runner.drainOnce(never);
    expect(queue.stats().queued).toBe(2);
    expect(queue.stats().failed).toBe(0);
  });
});
