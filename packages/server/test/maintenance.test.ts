import { describe, expect, it, vi } from "vitest";
import { registerMaintenanceSweep, runMaintenanceSweep } from "../src/db/maintenance";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { Scheduler } from "../src/scheduler/scheduler";
import { openMemoryDb } from "./helpers";

function freshDb(): Database {
  const db = openMemoryDb();
  provisionCacheDb(db);
  return db;
}

describe("cache.db maintenance sweep (THE-292)", () => {
  it("purges expired rows, trims event_log to retention, keeps live + in-flight rows", () => {
    const db = freshDb();
    const now = 10_000_000_000;
    const idem =
      "INSERT INTO idempotency_keys (vault_id, key, tool_name, args_hash, started_at, completed_at, result, result_size, expires_at) VALUES (?,?,?,?,?,?,?,?,?)";
    db.prepare(idem).run("v1", "old", "t", "h", now - 100_000, now - 90_000, "{}", 2, now - 1);
    db.prepare(idem).run("v1", "live", "t", "h", now - 100_000, now - 90_000, "{}", 2, now + 1000);
    // Crashed in-flight row: the EXPIRED-ONLY sweep must NOT reap it before expires_at —
    // dispatch-path reclaim (THE-293) owns that.
    db.prepare(idem).run("v1", "inflight", "t", "h", now - 120_000, null, null, null, now + 1000);
    const el =
      "INSERT INTO elicit_tokens (token, vault_id, tool_name, args_hash, proposed_change_json, caller, created_at, expires_at, consumed_at) VALUES (?,?,?,?,?,?,?,?,?)";
    db.prepare(el).run("tok-old", "v1", "t", "h", null, "c", now - 400_000, now - 1, null);
    db.prepare(el).run("tok-live", "v1", "t", "h", null, "c", now - 400_000, now + 1000, null);
    const ev =
      "INSERT INTO event_log (ts, vault_id, tool_name, caller, duration_ms, result_size, status, error_code, args_hash, event_type) VALUES (?,?,?,?,?,?,?,?,?,?)";
    db.prepare(ev).run(now - 31 * 86_400_000, "v1", "t", "c", 1, 1, "ok", null, "h", null);
    db.prepare(ev).run(now - 1 * 86_400_000, "v1", "t", "c", 1, 1, "ok", null, "h", null);

    const counts = runMaintenanceSweep(db, {
      now: () => now,
      eventLogDays: 30,
      jobsCompleteDays: 7,
      jobsFailedDays: 30,
    });
    // THE-571 added `jobs`; this db has none, so the terminal-row sweep reports 0.
    expect(counts).toEqual({ idempotency_keys: 1, elicit_tokens: 1, event_log: 1, jobs: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").get()).toMatchObject({
      n: 2,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM elicit_tokens").get()).toMatchObject({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM event_log").get()).toMatchObject({ n: 1 });
  });

  it("registerMaintenanceSweep ticks on the interval, reports counts, and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      const db = freshDb();
      const seen: unknown[] = [];
      const sched = new Scheduler();
      registerMaintenanceSweep(sched, {
        db,
        intervalMs: 1000,
        eventLogDays: 30,
        jobsCompleteDays: 7,
        jobsFailedDays: 30,
        now: () => 10_000_000_000,
        onSweep: (c) => seen.push(c),
      });
      sched.start();
      await vi.advanceTimersByTimeAsync(3500);
      expect(seen).toHaveLength(3);
      await sched.stop();
      await vi.advanceTimersByTimeAsync(3000);
      expect(seen).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes a sweep failure to onError without escaping", async () => {
    vi.useFakeTimers();
    try {
      const bad = {
        prepare() {
          throw new Error("boom");
        },
        exec() {},
      } as unknown as Database;
      const errs: unknown[] = [];
      const sched = new Scheduler();
      registerMaintenanceSweep(sched, {
        db: bad,
        intervalMs: 1000,
        eventLogDays: 30,
        jobsCompleteDays: 7,
        jobsFailedDays: 30,
        onError: (e) => errs.push(e),
      });
      sched.start();
      await vi.advanceTimersByTimeAsync(1100);
      expect(errs).toHaveLength(1);
      await sched.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

// THE-571 (#14 follow-up): the durable queue never pruned finished rows, so `jobs` grew without
// bound on a long-running server — `complete` rows accumulated forever and `failed` rows were kept
// "for inspection" with no upper bound.
//
// The sweep is TERMINAL-ONLY and that is the whole safety argument: a queued / running / retrying
// row is live work, and deleting one loses a job outright (a `running` row is how crash recovery
// finds work whose lease expired). Age is irrelevant for those — a retrying job with a long backoff
// is legitimately old.
//
// Retention must also stay LONGER than the longest once-per-period dedup window. enqueue() dedups
// against a terminal row unless replaceIfTerminal is set, which is how "a completed weekly synthesis
// must block re-runs" works; sweeping that row away lets the period run again. The defaults are days
// vs a weekly period, so the margin is wide — but it is a real constraint, not an implementation
// detail, so it is asserted here rather than left to a comment.
describe("THE-571 jobs retention sweep", () => {
  const now = 10_000_000_000;
  const DAY = 86_400_000;
  const insertJob = (
    db: Database,
    id: string,
    state: string,
    updatedAt: number,
    idempotencyKey: string | null = null,
  ) =>
    db
      .prepare(
        "INSERT INTO jobs (id, type, class, state, attempt, max_attempts, payload, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,0,5,?,?,?,?)",
      )
      .run(id, "contradiction", "contradiction", state, "{}", idempotencyKey, updatedAt, updatedAt);

  const sweep = (db: Database) =>
    runMaintenanceSweep(db, {
      now: () => now,
      eventLogDays: 30,
      jobsCompleteDays: 7,
      jobsFailedDays: 30,
    });

  it("deletes COMPLETE rows past retention and keeps recent ones", () => {
    const db = freshDb();
    insertJob(db, "old-complete", "complete", now - 8 * DAY);
    insertJob(db, "new-complete", "complete", now - 1 * DAY);
    const counts = sweep(db);
    expect(counts.jobs).toBe(1);
    expect(db.prepare("SELECT id FROM jobs").all()).toEqual([{ id: "new-complete" }]);
  });

  it("keeps FAILED rows longer than complete ones, then ages them out", () => {
    const db = freshDb();
    insertJob(db, "old-failed", "failed", now - 31 * DAY);
    // Older than the COMPLETE window but inside the FAILED one — kept for inspection.
    insertJob(db, "mid-failed", "failed", now - 10 * DAY);
    const counts = sweep(db);
    expect(counts.jobs).toBe(1);
    expect(db.prepare("SELECT id FROM jobs").all()).toEqual([{ id: "mid-failed" }]);
  });

  it("NEVER deletes an active row, however old — that would lose live work", () => {
    const db = freshDb();
    // All far past every retention window. A `running` row this old is precisely a crashed job
    // awaiting lease reclaim; a `retrying` one may simply have a long backoff.
    insertJob(db, "ancient-queued", "queued", now - 365 * DAY);
    insertJob(db, "ancient-running", "running", now - 365 * DAY);
    insertJob(db, "ancient-retrying", "retrying", now - 365 * DAY);
    const counts = sweep(db);
    expect(counts.jobs).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toMatchObject({ n: 3 });
  });

  it("frees the idempotency key of a swept row, so that content can be enqueued again", () => {
    // The consequence worth stating out loud: dedup lives in the UNIQUE index on idempotency_key,
    // so deleting a terminal row restores re-runnability for that key. Intended for content-keyed
    // jobs; safe for period-keyed ones only because retention outlives the period.
    const db = freshDb();
    insertJob(db, "swept", "complete", now - 8 * DAY, "v1:chunk:hash");
    sweep(db);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE idempotency_key = ?").get("v1:chunk:hash"),
    ).toMatchObject({ n: 0 });
  });

  it("is a no-op on a cache.db predating the jobs migration", () => {
    // The realistic shape: a db with every OTHER maintenance table but no `jobs` (pre
    // 20260723_002). The sweep must trim what it can rather than throwing and abandoning the rest
    // of the pass — a bare db without idempotency_keys was never supported and still isn't.
    const db = freshDb();
    db.exec("DROP TABLE jobs");
    let counts: ReturnType<typeof runMaintenanceSweep> | undefined;
    expect(() => {
      counts = runMaintenanceSweep(db, {
        now: () => now,
        eventLogDays: 30,
        jobsCompleteDays: 7,
        jobsFailedDays: 30,
      });
    }).not.toThrow();
    expect(counts?.jobs).toBe(0);
  });
});
