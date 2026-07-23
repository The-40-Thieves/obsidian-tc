// THE-517 — durable job queue. Every retry/backoff/lease fact lives in the `jobs` row; there is
// no in-memory JobState anywhere in job-queue.ts to diverge from it. These tests exercise the
// five behaviours the ticket calls out as non-negotiable:
//   1. crash recovery via lease expiry (exactly-once pickup)
//   2. cancellation that actually interrupts in-flight work, not just marks a row
//   3. idempotency keys
//   4. dead-letter after max attempts
//   5. no divergence between an in-memory count and the persisted one
import { describe, expect, it, vi } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { JobQueue, runJob } from "../src/scheduler/job-queue";
import { openMemoryDb } from "./helpers";

function db(): Database {
  const d = openMemoryDb();
  provisionCacheDb(d);
  return d;
}

describe("JobQueue (THE-517)", () => {
  it("enqueue -> claim -> complete: basic roundtrip", () => {
    const q = new JobQueue(db(), { now: () => 1000 });
    const job = q.enqueue("index-note", { payload: { path: "a.md" } });
    expect(job.state).toBe("queued");
    expect(job.attempt).toBe(0);

    const claimed = q.claim({ leaseOwner: "w1" });
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.state).toBe("running");
    expect(claimed?.attempt).toBe(1);
    expect(claimed?.payload).toEqual({ path: "a.md" });

    expect(q.claim({ leaseOwner: "w2" })).toBeNull(); // nothing else due

    expect(q.complete(job.id, "w1")).toBe(true);
    expect(q.get(job.id)?.state).toBe("complete");
  });

  // --- HARD TEST 1: crash recovery via lease expiry --------------------------------------------
  it("crash recovery: a lease that expires without release is picked up by another worker EXACTLY ONCE", () => {
    let t = 0;
    const shared = db();
    const q = new JobQueue(shared, { now: () => t, leaseMs: 1000 });
    const job = q.enqueue("reindex-vault");

    const claimedByCrashedWorker = q.claim({ leaseOwner: "worker-A" });
    expect(claimedByCrashedWorker?.leaseOwner).toBe("worker-A");
    // worker-A crashes here: no complete(), no fail(), no heartbeat. Nothing released.

    // Before the lease expires, nobody else can claim it.
    t = 500;
    expect(q.claim({ leaseOwner: "worker-B" })).toBeNull();

    // Past lease_expires_at, a second worker reclaims the SAME job.
    t = 1500;
    const reclaimed = q.claim({ leaseOwner: "worker-B" });
    expect(reclaimed?.id).toBe(job.id);
    expect(reclaimed?.leaseOwner).toBe("worker-B");
    expect(reclaimed?.attempt).toBe(2); // second execution attempt (first died with the worker)

    // And it is claimed EXACTLY ONCE: a third worker finds nothing due right after.
    expect(q.claim({ leaseOwner: "worker-C" })).toBeNull();

    // worker-B finishes the job it inherited.
    expect(q.complete(job.id, "worker-B")).toBe(true);
    expect(q.get(job.id)?.state).toBe("complete");
    // The dead worker-A can no longer touch the row it lost the lease on.
    expect(q.heartbeat(job.id, "worker-A")).toBe(false);
  });

  it("crash recovery resumes from the last checkpoint, not from scratch", () => {
    let t = 0;
    const shared = db();
    const q = new JobQueue(shared, { now: () => t, leaseMs: 1000 });
    const job = q.enqueue("long-index");
    const claimed = q.claim({ leaseOwner: "worker-A" }) as NonNullable<ReturnType<typeof q.claim>>;
    q.checkpoint(claimed.id, "worker-A", { processedFiles: 42 });
    // worker-A crashes mid-run, past checkpoint.

    t = 1500;
    const reclaimed = q.claim({ leaseOwner: "worker-B" });
    expect(reclaimed?.checkpoint).toEqual({ processedFiles: 42 });
    void job;
  });

  // --- HARD TEST 2: cancellation actually interrupts in-flight work --------------------------
  // Three stand-ins for the real interruption points the ticket names (a model request, a SQLite
  // loop, a bridge op) all watch the SAME AbortSignal that runJob hands the handler. Each proves
  // it stopped early — by elapsed time AND by an explicit "did I finish everything" sentinel —
  // rather than merely having the job row flip to a terminal state while work continues unseen.
  it("cancellation propagates: a model request, a SQLite loop, and a bridge op all stop mid-flight", async () => {
    const shared = db();
    const q = new JobQueue(shared, { now: () => 0, leaseMs: 100 });
    const job = q.enqueue("heavy-job");
    const claimed = q.claim({ leaseOwner: "w1" }) as NonNullable<ReturnType<typeof q.claim>>;

    // A real table to loop over, so the "SQLite loop" stand-in issues real prepared-statement
    // calls, not a bare JS loop.
    shared.exec("CREATE TABLE scan_rows (id INTEGER PRIMARY KEY)");
    const insert = shared.prepare("INSERT INTO scan_rows (id) VALUES (?)");
    for (let i = 0; i < 1000; i++) insert.run(i);

    let sqliteRowsScanned = 0;
    let sqliteLoopFinished = false;
    let modelRequestSettled: "aborted" | "completed" | null = null;
    let bridgeOpSettled: "aborted" | "completed" | null = null;

    function fakeModelRequest(signal: AbortSignal): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const timer = setTimeout(() => {
          modelRequestSettled = "completed"; // would only happen if NOT interrupted
          resolve();
        }, 10_000); // long enough that the test would time out if this actually had to elapse
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            modelRequestSettled = "aborted";
            reject(signal.reason);
          },
          { once: true },
        );
      });
    }

    function fakeBridgeOp(signal: AbortSignal): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const timer = setTimeout(() => {
          bridgeOpSettled = "completed";
          resolve();
        }, 10_000);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            bridgeOpSettled = "aborted";
            reject(signal.reason);
          },
          { once: true },
        );
      });
    }

    async function sqliteLoop(signal: AbortSignal): Promise<void> {
      const rows = shared.prepare("SELECT id FROM scan_rows ORDER BY id").all() as { id: number }[];
      for (const row of rows) {
        if (signal.aborted) throw signal.reason;
        sqliteRowsScanned++;
        void row;
        // yield so the cancellation event loop tick (setTimeout(0) below) gets a chance to fire
        await new Promise((r) => setTimeout(r, 0));
        if (sqliteRowsScanned >= 900) break; // guard: would finish before abort lands otherwise
      }
      sqliteLoopFinished = true;
    }

    const started = Date.now();
    const runPromise = runJob(
      q,
      claimed,
      "w1",
      async (_job, ctx) => {
        await sqliteLoop(ctx.signal);
        await fakeModelRequest(ctx.signal);
        await fakeBridgeOp(ctx.signal);
      },
      { heartbeatMs: 5 },
    );

    // Request cancellation shortly after the job starts, while the sqlite loop is still yielding.
    await new Promise((r) => setTimeout(r, 20));
    q.requestCancel(claimed.id);

    const result = await runPromise;
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2_000); // nowhere near the 10s the fakes would take if uninterrupted
    expect(sqliteLoopFinished).toBe(false); // the SQLite loop did NOT run to completion
    expect(sqliteRowsScanned).toBeLessThan(900); // stopped mid-scan
    expect(modelRequestSettled).not.toBe("completed"); // never reached / interrupted before firing
    expect(bridgeOpSettled).not.toBe("completed"); // bridge op never got a chance to "complete"

    expect(result.outcome).toBe("failed"); // cancellation dead-letters immediately, no retry
    const final = q.get(job.id);
    expect(final?.state).toBe("failed");
    expect(q.claim({ leaseOwner: "w2" })).toBeNull(); // not re-queued for retry
  });

  // --- HARD TEST 3: idempotency ---------------------------------------------------------------
  it("idempotency: the same key enqueued twice yields one job, run once", () => {
    const shared = db();
    const q = new JobQueue(shared, { now: () => 0 });
    const first = q.enqueue("send-webhook", { idempotencyKey: "evt-123", payload: { n: 1 } });
    const second = q.enqueue("send-webhook", { idempotencyKey: "evt-123", payload: { n: 2 } });
    expect(second.id).toBe(first.id);
    expect(second.payload).toEqual({ n: 1 }); // the SECOND enqueue is a no-op, not an overwrite

    const claim1 = q.claim({ leaseOwner: "w1" });
    expect(claim1?.id).toBe(first.id);
    q.complete(first.id, "w1");
    expect(q.claim({ leaseOwner: "w2" })).toBeNull(); // no second row to run

    const rows = shared
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE idempotency_key = ?")
      .get("evt-123") as { n: number };
    expect(rows.n).toBe(1);
  });

  // --- HARD TEST 4: dead-letter -----------------------------------------------------------------
  it("dead-letter: a job exceeding max attempts lands in failed and is never retried again", () => {
    let t = 0;
    const shared = db();
    const q = new JobQueue(shared, { now: () => t, backoffBaseMs: 10 });
    const job = q.enqueue("flaky-job", { maxAttempts: 2 });

    const c1 = q.claim({ leaseOwner: "w1" });
    expect(c1?.attempt).toBe(1);
    q.fail(job.id, "w1", new Error("boom-1"));
    expect(q.get(job.id)?.state).toBe("retrying");

    t += 100;
    const c2 = q.claim({ leaseOwner: "w1" });
    expect(c2?.attempt).toBe(2);
    q.fail(job.id, "w1", new Error("boom-2")); // attempt (2) >= maxAttempts (2) -> dead-letter

    const final = q.get(job.id);
    expect(final?.state).toBe("failed");
    expect(final?.lastError).toBe("boom-2");

    t += 100_000;
    expect(q.claim({ leaseOwner: "w2" })).toBeNull(); // dead, never picked up again
  });

  // --- HARD TEST 5: no divergence ----------------------------------------------------------------
  it("no divergence: a fresh JobQueue instance over the same db sees the identical attempt count", () => {
    let t = 0;
    const shared = db(); // ONE physical db, standing in for the durable store surviving a restart
    const qBeforeRestart = new JobQueue(shared, { now: () => t });
    const job = qBeforeRestart.enqueue("resilient-job");
    qBeforeRestart.claim({ leaseOwner: "w1" });
    qBeforeRestart.fail(job.id, "w1", new Error("transient"));

    // Simulate a process restart: a BRAND NEW JobQueue instance, zero shared memory with the one
    // above, opened over the same db. It has no field that could hold a stale attempt count —
    // this is the architectural guarantee, not just a coincidence of this test's outcome.
    const qAfterRestart = new JobQueue(shared, { now: () => t });
    expect(qAfterRestart.get(job.id)?.attempt).toBe(qBeforeRestart.get(job.id)?.attempt);
    expect(qAfterRestart.get(job.id)?.attempt).toBe(1);

    // And claiming from the "restarted" instance continues the SAME attempt sequence — there is
    // no separate counter to have drifted while the process was down.
    t = 10_000;
    const reclaimed = qAfterRestart.claim({ leaseOwner: "w2" });
    expect(reclaimed?.attempt).toBe(2);
  });

  // --- bounded per-class concurrency --------------------------------------------------------
  it("bounded concurrency: claim() respects a per-class running cap", () => {
    const shared = db();
    const q = new JobQueue(shared, { now: () => 0 });
    q.enqueue("index-note", { class: "index" });
    q.enqueue("index-note", { class: "index" });
    q.enqueue("index-note", { class: "index" });

    const a = q.claim({ leaseOwner: "w1", classLimits: { index: 2 } });
    const b = q.claim({ leaseOwner: "w2", classLimits: { index: 2 } });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // A third claim finds two already running (class at capacity) -> nothing claimable.
    const c = q.claim({ leaseOwner: "w3", classLimits: { index: 2 } });
    expect(c).toBeNull();

    q.complete((a as NonNullable<typeof a>).id, "w1");
    // Capacity freed -> the third job is now claimable.
    const d = q.claim({ leaseOwner: "w4", classLimits: { index: 2 } });
    expect(d).not.toBeNull();
  });

  // --- THE-517 follow-up: lease fencing in runJob --------------------------------------------
  // The tests above all drive claim()/complete()/fail() directly against ONE JobQueue instance,
  // so a genuine lease reclaim by a SECOND worker while runJob's handler is mid-flight was never
  // exercised. These reproduce that scenario: two independent lease owners racing over the same
  // db, wired through runJob rather than called by hand.
  describe("lease fencing (runJob observes lost leases instead of ignoring them)", () => {
    it("heartbeat observes lease loss and aborts the handler with outcome 'lease-lost'", async () => {
      vi.useFakeTimers();
      try {
        let t = 0;
        const shared = db();
        const q = new JobQueue(shared, { now: () => t, leaseMs: 100 });
        const job = q.enqueue("contested-job");
        const claimedA = q.claim({ leaseOwner: "ownerA" }) as NonNullable<
          ReturnType<typeof q.claim>
        >;

        let abortSeen = false;
        const runPromise = runJob(
          q,
          claimedA,
          "ownerA",
          (_job, ctx) =>
            new Promise<void>((_resolve, reject) => {
              ctx.signal.addEventListener(
                "abort",
                () => {
                  abortSeen = true;
                  reject(ctx.signal.reason);
                },
                { once: true },
              );
            }),
          { heartbeatMs: 10 },
        );

        // The lease expires and a SECOND worker reclaims the exact row ownerA is still "running"
        // — the case the shared-single-instance tests above structurally cannot exercise.
        t = 150; // past lease_expires_at (claimed at t=0, leaseMs=100)
        const claimedB = q.claim({ leaseOwner: "ownerB" });
        expect(claimedB?.id).toBe(job.id); // confirms ownerB genuinely reclaimed it

        // Next heartbeat tick: ownerA's heartbeat() call now fails (lease_owner is ownerB), so
        // runJob must abort the handler's signal rather than let it keep running unopposed.
        await vi.advanceTimersByTimeAsync(20);

        const result = await runPromise;
        expect(abortSeen).toBe(true);
        expect(result.outcome).toBe("lease-lost");
        expect((result as { error?: unknown }).error).toBeInstanceOf(DOMException);
      } finally {
        vi.useRealTimers();
      }
    });

    it("complete() failing after a successful handler yields 'lease-lost', not 'complete'", async () => {
      let t = 0;
      const shared = db();
      const q = new JobQueue(shared, { now: () => t, leaseMs: 50 });
      const job = q.enqueue("finishes-late");
      const claimed = q.claim({ leaseOwner: "ownerA" }) as NonNullable<ReturnType<typeof q.claim>>;

      const result = await runJob(
        q,
        claimed,
        "ownerA",
        async () => {
          // ownerA's handler finishes its work successfully, but slowly enough that its lease
          // expired and a second worker already reclaimed the job before ownerA's own
          // queue.complete() call below gets to run. This is the headline THE-517 case: work
          // finished, but the completion was never persisted under ownerA's name.
          t = 100; // past lease_expires_at (claimed at t=0, leaseMs=50)
          const reclaimed = q.claim({ leaseOwner: "ownerB" });
          expect(reclaimed?.id).toBe(job.id);
        },
        { heartbeatMs: 1_000_000 }, // never fires in this test; complete() is what fails here
      );

      expect(result.outcome).toBe("lease-lost");
      // The row reflects ownerB's reclaim, not a spurious "complete" written by ownerA.
      expect(q.get(job.id)?.leaseOwner).toBe("ownerB");
      expect(q.get(job.id)?.state).toBe("running");
    });

    it("heartbeatMs default derives from leaseMs (leaseMs/3), not a fixed constant", async () => {
      vi.useFakeTimers();
      try {
        const t = 0;
        const shared = db();
        // leaseMs/3 = 10ms. The old hardcoded default was 5_000ms, which would land zero
        // heartbeats inside a 15ms fake-timer advance.
        const q = new JobQueue(shared, { now: () => t, leaseMs: 30 });
        const job = q.enqueue("short-lease-job");
        const claimed = q.claim({ leaseOwner: "w1" }) as NonNullable<ReturnType<typeof q.claim>>;
        void job;

        const heartbeatSpy = vi.spyOn(q, "heartbeat");
        let resolveHandler: () => void = () => {};
        const handlerDone = new Promise<void>((resolve) => {
          resolveHandler = resolve;
        });
        const runPromise = runJob(q, claimed, "w1", async () => {
          await handlerDone;
        });

        // Advance past ONE default-derived heartbeat interval, nowhere near the old fixed 5s.
        await vi.advanceTimersByTimeAsync(15);
        expect(heartbeatSpy).toHaveBeenCalled();

        resolveHandler();
        await vi.advanceTimersByTimeAsync(0);
        const result = await runPromise;
        expect(result.outcome).toBe("complete");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
