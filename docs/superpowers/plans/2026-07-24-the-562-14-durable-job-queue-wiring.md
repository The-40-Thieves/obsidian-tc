# Durable JobQueue Wiring (THE-562 #14) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route both the contradiction-detection and plane-consolidation workloads through the already-built durable `JobQueue`, via one generic runner on the shared scheduler, so their work is crash-safe, retryable, and dead-letterable — and remove the queue's "not yet wired" reachability-allowlist entry.

**Architecture:** The `JobQueue` (THE-517) already provides `enqueue`/`claim`/`complete`/`fail` (backoff + dead-letter) and `runJob()` (lease heartbeat, cancellation, lease-loss). This plan adds (1) `JobQueue.stats()`, (2) a generic `job-runner.ts` that claims + dispatches by type, (3) producers that enqueue instead of pushing to an in-memory queue / firing a bespoke timer, (4) handlers adapting `checkContradictions`/`runSynthesis`/`runAudit`, (5) a `server_health` job-queue block, and removes the in-memory contradiction drain, `registerPlaneScheduler`, and the allowlist entry.

**Tech Stack:** TypeScript, Bun, Vitest, SQLite `Database`, monorepo package `@the-40-thieves/obsidian-tc-server`.

## Global Constraints

- **Commits:** DCO-signed (`git commit -s`); every message ends with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **JobQueue API (exact):** `new JobQueue(db, { now?, leaseMs?, maxAttempts?, backoffBaseMs?, maxBackoffMs? })`; `enqueue(type, { class?, maxAttempts?, idempotencyKey?, payload? }) → Job`; `claim({ leaseOwner, types?, leaseMs?, classLimits? }) → Job | null`; `complete(id, owner)`, `fail(id, owner, err, {terminal?})`, `checkpoint(id, owner, data)`; `runJob(queue, job, owner, handler, opts?) → { outcome }`; `queue.leaseMs` getter; `Job.payload` is `unknown` (JSON round-tripped). The claim option is **`classLimits`**, not `maxConcurrentPerClass`.
- **Retry policy (per-type):** `contradiction` → `maxAttempts: 3`; `synthesis`/`audit` → `maxAttempts: 1` (they regenerate next cycle). Backoff is the queue's built-in.
- **No migration** — the `jobs` table exists (`20260723_002_jobs.sql`); do not touch it (applied-migration checksum is verified).
- **Verification (before any push):** run `bun run typecheck` at the **repo ROOT** (all packages — vitest strips types, so a runtime-passing test can still fail CI's monorepo tsc), plus `bun run lint` and the full server suite (`cd packages/server && bun run test`), plus `node scripts/check-boundaries.mjs`.
- **Tests live in** `packages/server/test/*.test.ts`; in-memory DBs via `openMemoryDb()` + `runMigrations`/`provisionCacheDb`.

---

## File Structure

- Modify: `packages/server/src/scheduler/job-queue.ts` — add `stats()`.
- Create: `packages/server/src/scheduler/job-runner.ts` — the generic runner.
- Modify: `packages/server/src/cli.ts` — construct the queue + runner; replace the contradiction producer and the plane timer; remove the in-memory drain + `registerPlaneScheduler`.
- Modify: `packages/server/src/tools/admin/health.ts` — `job_queue` block.
- Modify: `scripts/check-boundaries.mjs` — remove the `job-queue.ts` allowlist entry.
- Modify: `packages/shared/src/config.schema.ts` — a defaulted `jobQueue` config section.
- Test: `job-queue-stats.test.ts`, `job-runner.test.ts`, `job-queue-integration.test.ts` (new); update `contradiction-drain.test.ts`, any `contradictions_dropped` asserters, `server-health*` test.

---

## Task 1: `JobQueue.stats()` — counts by state for observability

**Files:**
- Modify: `packages/server/src/scheduler/job-queue.ts` (add method to the `JobQueue` class, before `isCancelRequested`)
- Test: `packages/server/test/job-queue-stats.test.ts`

**Interfaces:**
- Produces: `stats(): { queued: number; running: number; retrying: number; complete: number; failed: number; oldestQueuedAgeMs: number | null }`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/job-queue-stats.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CACHE_MIGRATIONS } from "../src/db/provision";
import { runMigrations } from "../src/db/migrate";
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/server && bunx vitest run test/job-queue-stats.test.ts`
Expected: FAIL — `stats` is not a function.

- [ ] **Step 3: Implement `stats()`**

In `packages/server/src/scheduler/job-queue.ts`, add to the `JobQueue` class (immediately before `isCancelRequested`):

```ts
  /** #14: counts by state + oldest-queued age, for the server_health job-queue block. A non-zero
   *  `failed` is the dead-letter signal — a workload persistently failing, now durable and visible. */
  stats(): {
    queued: number;
    running: number;
    retrying: number;
    complete: number;
    failed: number;
    oldestQueuedAgeMs: number | null;
  } {
    const rows = this.db.prepare("SELECT state, COUNT(*) AS n FROM jobs GROUP BY state").all() as {
      state: JobState;
      n: number;
    }[];
    const by = { queued: 0, running: 0, retrying: 0, complete: 0, failed: 0 };
    for (const r of rows) by[r.state] = r.n;
    const oldest = this.db
      .prepare("SELECT MIN(created_at) AS t FROM jobs WHERE state = 'queued'")
      .get() as { t: number | null };
    return {
      ...by,
      oldestQueuedAgeMs: oldest.t == null ? null : Math.max(0, this.now() - oldest.t),
    };
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/server && bunx vitest run test/job-queue-stats.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/scheduler/job-queue.ts packages/server/test/job-queue-stats.test.ts
git commit -s -m "feat(THE-562 #14): JobQueue.stats() — counts by state for health/observability

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Generic runner — `scheduler/job-runner.ts`

**Files:**
- Create: `packages/server/src/scheduler/job-runner.ts`
- Test: `packages/server/test/job-runner.test.ts`

**Interfaces:**
- Consumes: `JobQueue`, `runJob`, `Job`, `RunJobContext` from `./job-queue`.
- Produces: `type JobHandler = (job: Job, ctx: RunJobContext) => Promise<void>`; `makeJobRunner(deps: JobRunnerDeps) → { drainOnce(signal: AbortSignal): Promise<void> }` where `JobRunnerDeps = { queue: JobQueue; leaseOwner: string; handlers: Map<string, JobHandler>; maxPerTick?: number; leaseMs?: number; classLimits?: Record<string, number>; onOutcome?: (type, outcome) => void }`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/job-runner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CACHE_MIGRATIONS } from "../src/db/provision";
import { runMigrations } from "../src/db/migrate";
import { type JobHandler, makeJobRunner } from "../src/scheduler/job-runner";
import { JobQueue } from "../src/scheduler/job-queue";
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
      ["a", async (job) => { seen.push(`a:${(job.payload as { v: string }).v}`); }],
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
      ["boom", async () => { throw new Error("nope"); }],
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
    const handlers = new Map<string, JobHandler>([["a", async () => { ran++; }]]);
    for (let i = 0; i < 5; i++) queue.enqueue("a", { idempotencyKey: String(i) });
    const runner = makeJobRunner({ queue, leaseOwner: "w", handlers, maxPerTick: 2 });
    await runner.drainOnce(never);
    expect(ran).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/server && bunx vitest run test/job-runner.test.ts`
Expected: FAIL — `../src/scheduler/job-runner` does not exist.

- [ ] **Step 3: Implement the runner**

Create `packages/server/src/scheduler/job-runner.ts`:

```ts
// #14 (THE-562 / THE-517): the generic runner that finally wires the durable JobQueue to work.
// It owns NO durability — claim/lease/retry/dead-letter/cancel all live in the queue + runJob. It
// only claims due jobs and dispatches each to its type's handler, bounded per tick. Registered on
// the shared Scheduler (THE-462) as one single-flight job, so its lifecycle, backoff, and bounded
// shutdown come for free.
import { type Job, JobQueue, type RunJobContext, runJob } from "./job-queue";

export type JobHandler = (job: Job, ctx: RunJobContext) => Promise<void>;

export interface JobRunnerDeps {
  queue: JobQueue;
  /** Stable per process (e.g. `serve:${pid}`) — the lease owner recorded on every claim. */
  leaseOwner: string;
  handlers: Map<string, JobHandler>;
  /** Max jobs processed per drainOnce (default 32). Bounds a single tick's work. */
  maxPerTick?: number;
  leaseMs?: number;
  /** Per-class RUNNING cap across ticks (JobQueue.claim classLimits). */
  classLimits?: Record<string, number>;
  onOutcome?: (
    type: string,
    outcome: "complete" | "retrying" | "failed" | "lease-lost",
  ) => void;
}

export function makeJobRunner(deps: JobRunnerDeps): {
  drainOnce: (signal: AbortSignal) => Promise<void>;
} {
  const maxPerTick = deps.maxPerTick ?? 32;
  const types = [...deps.handlers.keys()];

  return {
    async drainOnce(signal: AbortSignal): Promise<void> {
      for (let i = 0; i < maxPerTick; i++) {
        if (signal.aborted) return;
        const job = deps.queue.claim({
          leaseOwner: deps.leaseOwner,
          types,
          ...(deps.leaseMs !== undefined ? { leaseMs: deps.leaseMs } : {}),
          ...(deps.classLimits ? { classLimits: deps.classLimits } : {}),
        });
        if (!job) return; // queue drained (or every due class saturated) this tick
        const handler = deps.handlers.get(job.type);
        if (!handler) {
          // A queued type with no registered handler: fail it terminally rather than spin. This
          // only happens if a producer enqueues a type the runner was not configured for.
          deps.queue.fail(job.id, deps.leaseOwner, new Error(`no handler for job type ${job.type}`), {
            terminal: true,
          });
          deps.onOutcome?.(job.type, "failed");
          continue;
        }
        const { outcome } = await runJob(deps.queue, job, deps.leaseOwner, handler);
        deps.onOutcome?.(job.type, outcome);
      }
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/server && bunx vitest run test/job-runner.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/scheduler/job-runner.ts packages/server/test/job-runner.test.ts
git commit -s -m "feat(THE-562 #14): generic JobQueue runner (claim + dispatch-by-type on the scheduler)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Wire the contradiction workload (durable, no drops)

**Files:**
- Modify: `packages/server/src/cli.ts` — construct the `JobQueue`; build the handlers map with a `contradiction` handler; replace the `makeOnIndexed` producer; register the runner on the scheduler; remove the in-memory queue + `makeContradictionDrainer` + its registration + the `contradictions_dropped` field/metric; update the shutdown drain.
- Test: `packages/server/test/job-queue-integration.test.ts` (contradiction leg)
- Update: `packages/server/test/contradiction-drain.test.ts` (the drainer is removed — delete the file or convert its cases to the handler path), and any test asserting `contradictions_dropped`.

**Interfaces:**
- Consumes: `JobQueue`, `makeJobRunner`, `checkContradictions(ctx, vaultId, chunks)`, `IndexedChunk`.
- Produces: a `jobQueue: JobQueue` on `db`; a `contradiction` job type with payload `{ vaultId: string; chunk: IndexedChunk }` and idempotency key `${vaultId}:${chunk.id}`.

- [ ] **Step 1: Write the failing integration test**

Create `packages/server/test/job-queue-integration.test.ts`. Provision a cache.db, seed a vault + two conflicting chunks (mirror `contradiction-job.test.ts`'s fixture), build a `JobQueue`, a `contradiction` handler = `(job, ctx) => checkContradictions({ db, roles, now, model }, payload.vaultId, [payload.chunk]).then(() => {})`, and a runner. Assert: enqueuing the same `${vault}:${chunk}` key twice yields ONE job (idempotency); `drainOnce` flags the contradiction and completes the job; a handler whose `roles.judge` throws goes `retrying` then `failed` at attempt 3.

> Reuse `contradiction-job.test.ts`'s `checkContradictions` fixture builders and `rolesReturning` verbatim; only the enqueue→run wrapping is new.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/server && bunx vitest run test/job-queue-integration.test.ts`
Expected: FAIL (assertions unmet until the handler wiring exists — or a compile error if referencing not-yet-exported helpers; write the handler inline in the test so it fails on behavior, not import).

- [ ] **Step 3: Construct the queue + contradiction handler + runner in cli.ts**

In `packages/server/src/cli.ts`, add the import near the scheduler imports:

```ts
import { JobQueue } from "./scheduler/job-queue";
import { type JobHandler, makeJobRunner } from "./scheduler/job-runner";
```

Where `contradictionQueue` is declared (currently ~line 1008–1024), replace the in-memory queue + `makeOnIndexed` push with the durable enqueue:

```ts
  // #14: durable contradiction jobs (was an in-memory queue that dropped under backpressure).
  const jobQueue = new JobQueue(db, { now: Date.now });
  const CONTRADICTION_MAX_ATTEMPTS = 3;
  const makeOnIndexed = (vaultId: string): IndexHook | undefined =>
    roles
      ? (chunks) => {
          for (const c of chunks) {
            jobQueue.enqueue("contradiction", {
              class: "contradiction",
              payload: { vaultId, chunk: c },
              // same rapid-reindex dedup groupContradictionQueue gave — now durable
              idempotencyKey: `${vaultId}:${c.id}`,
              maxAttempts: CONTRADICTION_MAX_ATTEMPTS,
            });
          }
        }
      : undefined;
```

Delete: the `contradictionQueue` array, `CONTRADICTION_QUEUE_MAX`, `CONTRADICTION_DRAIN_BATCH`, the `makeContradictionDrainer(...)` construction, and `indexHealth.contradictionsDropped` (field at ~910, init at ~924, and the `contradictions_dropped` in the health block at ~949 — replace that metric with the queue stats added in Task 5, or drop it here and add it in Task 5).

Build the handlers map + runner (place after `roles`/`embeddingProvider` are defined, before the scheduler is started):

```ts
  const jobHandlers = new Map<string, JobHandler>();
  if (roles) {
    jobHandlers.set("contradiction", async (job) => {
      const { vaultId, chunk } = job.payload as { vaultId: string; chunk: IndexedChunk };
      await checkContradictions(
        { db, roles, now: Date.now, model: embeddingProvider.id },
        vaultId,
        [chunk],
      );
    });
    // plane handlers are added in Task 4
  }
  const jobRunner = makeJobRunner({
    queue: jobQueue,
    leaseOwner: `serve:${process.pid}`,
    handlers: jobHandlers,
    classLimits: { contradiction: 4, plane: 1 },
    // outcomes are surfaced via server_health stats, not per-job logging; onOutcome left unset
  });
```

Register the runner on the scheduler (replace the `contradiction-drain` registration at ~1558–1563):

```ts
  if (roles) {
    scheduler.register({
      name: "job-queue-runner",
      intervalMs: CONTRADICTION_DRAIN_MS,
      run: (signal) => jobRunner.drainOnce(signal),
    });
  }
```

Update the shutdown drain (~1558–1566): replace `contradictionDrainer.inFlight`/`drainOnce` with a final `jobRunner.drainOnce(<aborted-after-deadline signal>)` — or simply drop the contradiction-specific drain, since durable jobs survive the restart and the next tick resumes them. Keep the `indexCoordinator.idle()` await.

- [ ] **Step 4: Run to verify the integration + suite**

Run: `cd packages/server && bunx vitest run test/job-queue-integration.test.ts`
Expected: PASS.
Run: `cd packages/server && bun run test` (the removed drainer must not leave dangling references)
Expected: PASS. Delete/rewrite `contradiction-drain.test.ts` and fix any `contradictions_dropped` asserters.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/cli.ts packages/server/test/job-queue-integration.test.ts packages/server/test/contradiction-drain.test.ts
git commit -s -m "feat(THE-562 #14): route contradiction detection through the durable JobQueue (no drops)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire the plane workload (synthesis + audit)

**Files:**
- Modify: `packages/server/src/cli.ts` — add `synthesis`/`audit` handlers to `jobHandlers`; replace `registerPlaneScheduler` with an enqueue-on-tick timer.
- Test: extend `packages/server/test/job-queue-integration.test.ts` (plane leg)

**Interfaces:**
- Consumes: `runSynthesis`, `auditJob` (`runAudit`), `isoWeek`, `JobContext`.
- Produces: `synthesis` / `audit` job types (`class: "plane"`, `maxAttempts: 1`, idempotency `synthesis:<isoWeek>` / `audit:<yyyymmdd>`).

- [ ] **Step 1: Write the failing test (plane leg)**

Add to `job-queue-integration.test.ts`: enqueue a `synthesis` job over a two-vault chunk fixture (reuse `synthesis-job.test.ts`), run the handler via the runner, assert a `syntheses` row per vault and the job `complete`; assert a second enqueue with the same `synthesis:<isoWeek>` key is a no-op (one job); assert a handler failure with `maxAttempts: 1` dead-letters immediately (`failed`, not `retrying`).

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/server && bunx vitest run test/job-queue-integration.test.ts`
Expected: FAIL on the plane assertions.

- [ ] **Step 3: Add plane handlers + enqueue-on-tick**

In `cli.ts`, extend the `if (roles)` handler block (Task 3):

```ts
    jobHandlers.set("synthesis", async () => {
      await runSynthesis({ db, roles, now: Date.now });
    });
    jobHandlers.set("audit", async () => {
      await auditJob.run({ db, roles, now: Date.now });
    });
```

Replace the `registerPlaneScheduler(...)` block (currently ~1523–1536) with an enqueue-on-tick timer on the same interval:

```ts
  // #14: the plane consolidation is now durable jobs — a transient gateway failure retries/dead-
  // letters instead of vanishing. Idempotency keys keep a slow run from piling up duplicate
  // weekly/daily jobs; the job-queue-runner (registered above) executes them.
  if (config.plane.enabled && roles) {
    scheduler.register({
      name: "plane-enqueue",
      intervalMs: config.plane.intervalMinutes * 60_000,
      run: () => {
        const iso = isoWeek(new Date());
        jobQueue.enqueue("synthesis", {
          class: "plane",
          idempotencyKey: `synthesis:${iso.year}-${iso.week}`,
          maxAttempts: 1,
        });
        const day = new Date().toISOString().slice(0, 10);
        jobQueue.enqueue("audit", { class: "plane", idempotencyKey: `audit:${day}`, maxAttempts: 1 });
      },
    });
  }
```

Remove the now-unused `registerPlaneScheduler`/`SleepTimePlane` imports if nothing else references them (`grep`). `runSynthesis`/`auditJob` stay (imported for the handlers). Add `isoWeek` to the imports if not present.

- [ ] **Step 4: Run to verify + suite**

Run: `cd packages/server && bunx vitest run test/job-queue-integration.test.ts` → PASS.
Run: `cd packages/server && bun run test` → PASS (fix any `plane.test.ts`/`registerPlaneScheduler` references).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/cli.ts packages/server/test/job-queue-integration.test.ts
git commit -s -m "feat(THE-562 #14): route plane synthesis/audit through the durable JobQueue (retry + dead-letter)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `server_health` job-queue block

**Files:**
- Modify: `packages/server/src/tools/admin/health.ts` — add a `job_queue` block from `jobQueue.stats()`.
- Modify: `packages/server/src/cli.ts` — pass `jobQueue` into the M-health deps.
- Test: update the server-health test to assert the `job_queue` block.

**Interfaces:**
- Consumes: `JobQueue.stats()`.
- Produces: `server_health.job_queue = { queued, running, retrying, failed, oldest_queued_age_ms }`.

- [ ] **Step 1: Write the failing test**

In the existing server-health test (find it: `ls packages/server/test | grep -i health`), enqueue a job + dead-letter another, build the health tool with the queue, and assert `server_health` returns a `job_queue` block with `queued >= 1` and `failed >= 1`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/server && bunx vitest run <the health test file>`
Expected: FAIL — no `job_queue` in the result.

- [ ] **Step 3: Add the block**

Thread `jobQueue` into the health tool deps (the M-domain that owns `server_health` — pass it in `cli.ts` where that domain is registered), and in the `server_health` handler add:

```ts
        job_queue: deps.jobQueue
          ? (() => {
              const s = deps.jobQueue.stats();
              return {
                queued: s.queued,
                running: s.running,
                retrying: s.retrying,
                failed: s.failed, // dead-letter count — a persistently failing workload
                oldest_queued_age_ms: s.oldestQueuedAgeMs,
              };
            })()
          : undefined,
```

Add `jobQueue?: JobQueue` to that tool's deps interface.

- [ ] **Step 4: Run to verify + suite**

Run: `cd packages/server && bunx vitest run <the health test file>` → PASS.
Run: `cd packages/server && bun run test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/tools/admin/health.ts packages/server/src/cli.ts packages/server/test/*health*
git commit -s -m "feat(THE-562 #14): surface job-queue depth + dead-letter count in server_health

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Remove the reachability allowlist entry + config section; full gate + PR

**Files:**
- Modify: `scripts/check-boundaries.mjs` — remove the `job-queue.ts` `UNREACHABLE_ALLOWLIST` entry.
- Modify: `packages/shared/src/config.schema.ts` — a defaulted `jobQueue` config section (optional; wire the runner interval/leaseSeconds/contradictionConcurrency from it if added, else keep the literals from Tasks 3–4).

- [ ] **Step 1: Remove the allowlist entry**

In `scripts/check-boundaries.mjs`, delete the `UNREACHABLE_ALLOWLIST` entry:

```js
  [
    "packages/server/src/scheduler/job-queue.ts",
    "THE-517 — durable queue, not yet wired to a workload",
  ],
```

- [ ] **Step 2: Run the boundary gate**

Run: `node scripts/check-boundaries.mjs`
Expected: exit 0 — `job-queue.ts` is now reachable from `cli.ts` (via `job-runner.ts` / the enqueue calls), so it neither appears as UNWIRED nor as a stale allowlist entry. (If it reports "now reachable — remove from UNREACHABLE_ALLOWLIST", the entry is still present — delete it.)

- [ ] **Step 3: (Optional) config section**

If wiring config knobs, add to `packages/shared/src/config.schema.ts` a defaulted `jobQueue` object (`enabled` default true, `drainIntervalSeconds`, `leaseSeconds`, `contradictionConcurrency`, `maxPerTick`) and read it in `cli.ts` for the runner/enqueue literals. Defaulted so a config predating it validates unchanged. Re-render docgen (`bun run docgen:render`) if the schema changes (config-reference is generated).

- [ ] **Step 4: Full gate**

Run from repo root: `bun run lint`, `bun run typecheck` (all packages), `cd packages/server && bun run test`, `node scripts/check-boundaries.mjs`.
Expected: all green. Add a CHANGELOG entry (Added/Changed) for #14.

- [ ] **Step 5: Commit + PR**

```bash
git add scripts/check-boundaries.mjs packages/shared/src/config.schema.ts CHANGELOG.md docs/
git commit -s -m "feat(THE-562 #14): wire the durable JobQueue; drop the not-yet-wired allowlist entry

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push -u origin <branch>
gh pr create --base main --title "feat(THE-562 #14): wire the durable JobQueue to its workloads" --body "$(cat <<'EOF'
Closes THE-562 #14 (extends THE-517). Wires the already-built durable JobQueue to both background workloads via one generic runner.

- Generic runner (`scheduler/job-runner.ts`): claims + dispatches by type on the shared scheduler; all durability (lease/retry/dead-letter/cancel) stays in the queue + `runJob`.
- Contradiction detection → durable jobs (idempotency `vault:chunk`), replacing the in-memory queue that dropped under backpressure. No more silent drops.
- Plane synthesis/audit → durable jobs (maxAttempts 1) with retry/dead-letter instead of vanishing on a gateway failure.
- `JobQueue.stats()` + a `server_health` job-queue block (queued/running/retrying/failed) for backlog + dead-letter visibility.
- Removes the `job-queue.ts` reachability-allowlist entry — the literal close of #14.

Spec: `docs/superpowers/specs/2026-07-24-the-562-14-durable-job-queue-wiring-design.md`. Follow-up (filed): a `complete`-row retention sweep in the maintenance pass.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Confirm CI triggered with a non-zero check count; merge on green** (per the established cadence, after an adversarial whole-branch review — this changes the serve-path background execution model).

---

## Self-Review

**Spec coverage:** generic runner (T2) ✓; contradiction durable + no drops (T3) ✓; plane retry/dead-letter (T4) ✓; per-type maxAttempts (T3 `3` / T4 `1`) ✓; full-durable one-code-path (T3 removes the in-memory queue) ✓; server_health observability (T5) ✓; allowlist removal (T6) ✓; `JobQueue.stats()` (T1) ✓. Retention sweep = documented follow-up (spec), not a task ✓.

**Placeholder scan:** the cli.ts steps give exact old→new code for the load-bearing changes (producer, handlers, runner, plane timer, removals). Where a line reference may have drifted (T3 removals at ~910/924/949, T4 `registerPlaneScheduler` at ~1523), the step names the exact symbol to find (`contradictionQueue`, `makeContradictionDrainer`, `registerPlaneScheduler`, `contradictions_dropped`) so the edit is unambiguous. The server-health test file (T5) is located by `grep` because its exact name isn't pinned — the step says how to find it.

**Type consistency:** `classLimits` (not `maxConcurrentPerClass`) at every claim/runner site; `enqueue(type, {class, idempotencyKey, payload, maxAttempts})`; `Job.payload` cast to `{ vaultId, chunk }` (contradiction) matching the producer's payload shape; `makeJobRunner` deps identical in T2 (definition) and T3 (construction); handler signature `(job, ctx) => Promise<void>` throughout.

**Note:** T3/T4 both edit the same `cli.ts` `if (roles)` handler block and the scheduler region — T3 establishes it, T4 extends it. Execute in order; a reviewer sees T4's diff on top of T3's committed state.
