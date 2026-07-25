// THE-462 defect (b): the scheduler passed an AbortSignal to every job, and every job threw it
// away. `JobSpec.run` is typed `(signal: AbortSignal) => ...` and runJob passes `this.abort.signal`,
// but both real consumers were registered as zero-arg closures — so stop() aborted the scheduler's
// own waiting while the in-flight job body ran to completion regardless.
//
// The plumbing existed; nothing was plugged into it. These tests plug it in at the two natural
// cancellation points: between plane jobs, and between units of work in a drain batch.
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { CACHE_MIGRATIONS, provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import type { GatewayRoles } from "../src/plane/gateway";
import { SleepTimePlane } from "../src/plane/plane";
import { JobQueue } from "../src/scheduler/job-queue";
import { type JobHandler, makeJobRunner } from "../src/scheduler/job-runner";
import { openMemoryDb } from "./helpers";

/** The plane introspects the schema before dispatching a job, so it needs a real db. */
function realDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}
const stubRoles = {} as unknown as GatewayRoles;

/** A migrated cache db + queue, matching job-runner.test.ts's harness. */
function queued(): JobQueue {
  const db = openMemoryDb();
  runMigrations(db, CACHE_MIGRATIONS);
  return new JobQueue(db, { now: () => 1000, leaseMs: 30_000, maxAttempts: 2 });
}

describe("THE-462(b): jobs honour the AbortSignal", () => {
  it("SleepTimePlane.runAll stops before the next job once aborted", async () => {
    const ran: string[] = [];
    const ctrl = new AbortController();
    const plane = new SleepTimePlane();
    plane.register({
      name: "first",
      run: async () => {
        ran.push("first");
        ctrl.abort(); // shutdown lands while the first job is running
        return { ok: true } as never;
      },
    } as never);
    plane.register({
      name: "second",
      run: async () => {
        ran.push("second");
        return { ok: true } as never;
      },
    } as never);

    await plane.runAll({
      db: realDb(),
      roles: stubRoles,
      now: () => 0,
      signal: ctrl.signal,
    } as never);

    expect(ran).toEqual(["first"]);
  });

  it("SleepTimePlane.runAll runs every job when not aborted", async () => {
    const ran: string[] = [];
    const plane = new SleepTimePlane();
    for (const name of ["a", "b"]) {
      plane.register({
        name,
        run: async () => {
          ran.push(name);
          return { ok: true } as never;
        },
      } as never);
    }

    await plane.runAll({ db: realDb(), roles: stubRoles, now: () => 0 } as never);

    expect(ran).toEqual(["a", "b"]);
  });

  // THE-570: these two previously exercised the in-memory contradiction drainer, which #14 replaced
  // with the durable JobQueue and this ticket deletes. The CONTRACT under test is unchanged — a
  // drain loop must stop between units of work once aborted — so it now runs against the runner
  // that actually ships. drainOnce checks signal.aborted at the top of each iteration.
  it("the durable job runner stops between jobs once aborted", async () => {
    const queue = queued();
    const ctrl = new AbortController();
    const ran: string[] = [];
    const handlers = new Map<string, JobHandler>([
      [
        "unit",
        async (job) => {
          ran.push((job.payload as { v: string }).v);
          ctrl.abort(); // shutdown lands while the first job is running
        },
      ],
    ]);
    for (const v of ["a", "b", "c"]) queue.enqueue("unit", { idempotencyKey: v, payload: { v } });

    await makeJobRunner({ queue, leaseOwner: "w", handlers }).drainOnce(ctrl.signal);

    expect(ran).toHaveLength(1);
    // The two it never reached are still claimable, not lost — an aborted drain must not consume
    // work it did not do.
    expect(queue.stats().queued).toBe(2);
  });

  it("the durable job runner processes every queued job when not aborted", async () => {
    const queue = queued();
    const ran: string[] = [];
    const handlers = new Map<string, JobHandler>([
      [
        "unit",
        async (job) => {
          ran.push((job.payload as { v: string }).v);
        },
      ],
    ]);
    for (const v of ["a", "b"]) queue.enqueue("unit", { idempotencyKey: v, payload: { v } });

    await makeJobRunner({ queue, leaseOwner: "w", handlers }).drainOnce(
      new AbortController().signal,
    );

    expect(ran.sort()).toEqual(["a", "b"]);
    expect(queue.stats().complete).toBe(2);
  });
});
