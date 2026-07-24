import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import { CACHE_MIGRATIONS } from "../src/db/provision";
import { JobQueue } from "../src/scheduler/job-queue";
import { openMemoryDb } from "./helpers";

function queue(now = 1000): JobQueue {
  const db = openMemoryDb();
  runMigrations(db, CACHE_MIGRATIONS);
  return new JobQueue(db, { now: () => now });
}

describe("JobQueue.stats", () => {
  it("counts jobs by state and reports the oldest queued age", () => {
    const q = queue(5000);
    q.enqueue("contradiction", { idempotencyKey: "a" });
    q.enqueue("contradiction", { idempotencyKey: "b" });
    const s = q.stats();
    expect(s.queued).toBe(2);
    expect(s.running).toBe(0);
    expect(s.failed).toBe(0);
    expect(s.oldestQueuedAgeMs).toBe(0); // enqueued at now=5000, read at now=5000
  });

  it("reflects a claimed job as running and a completed one as complete", () => {
    const q = queue();
    q.enqueue("t", { idempotencyKey: "x" });
    const job = q.claim({ leaseOwner: "w1", types: ["t"] });
    expect(q.stats().running).toBe(1);
    if (job) q.complete(job.id, "w1");
    const s = q.stats();
    expect(s.running).toBe(0);
    expect(s.complete).toBe(1);
  });
});
