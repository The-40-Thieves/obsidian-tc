# Wire the durable JobQueue to its workloads — THE-562 #14 (THE-517)

**Date:** 2026-07-24
**Parent:** THE-562 (Codex audit tail, item #14) · extends THE-517 (durable JobQueue), THE-462 (unified scheduler), THE-457 (contradiction drain)
**Baseline:** `main` @ `7443740`

## Problem

`scheduler/job-queue.ts` (THE-517) is a complete, crash-safe, DB-backed durable job queue — `enqueue` (idempotency-keyed), `claim` (lease + reclaim of expired leases, per-class concurrency), `checkpoint`, `complete`, `fail` (attempt tracking, exponential backoff, dead-letter → `failed`), and `runJob()` (per-job executor with lease heartbeat, real `AbortController`-backed cancellation, and lease-loss detection). It provisioned the `jobs` table (`20260723_002_jobs.sql`) and is fully tested — **but nothing claims from it.** The module sits in `check-boundaries.mjs`'s `UNREACHABLE_ALLOWLIST` marked "THE-517 — durable queue, not yet wired to a workload." Audit #14 asks: wire it, so its durability guarantees are real, and remove the allowlist entry.

Two background workloads currently lack the durability the queue provides:

1. **Contradiction drain** (`plane/jobs/contradiction-drain.ts`) — an **in-memory** bounded queue that **silently drops chunks under backpressure** (`contradictionsDropped` counter, `CONTRADICTION_QUEUE_MAX`) and loses all pending work on crash. The judge is a gateway call that would benefit from retry + dead-letter.
2. **Plane consolidation** (`SleepTimePlane` synthesis + audit via `registerPlaneScheduler`) — best-effort on the scheduler timer; a crash loses the in-flight run, and a transient gateway failure vanishes with no retry.

## Goal

A generic JobQueue runner on the shared scheduler, with both workloads routed through it as durable, retryable, dead-letterable jobs; queue depth + dead-letter counts surfaced in `server_health`; the `job-queue.ts` reachability-allowlist entry removed (the literal close of #14).

## Decisions (locked with the maintainer)

- **Full durable** — every indexed chunk enqueues a durable `contradiction` job (one DB write). No in-memory fast path, no hybrid: one code path, no drops.
- **Per-type retry policy** — `contradiction` = 3 attempts (transient judge/gateway errors), `synthesis`/`audit` = 1 attempt (they regenerate on the next cycle, so a failed run dead-letters immediately rather than retrying stale work). Exponential backoff between attempts (the queue's built-in).
- **Observability in `server_health`** — surface queued / running / retrying / failed(dead-letter) counts.

## Design

### 1. Generic runner — `scheduler/job-runner.ts` (new)

A thin orchestrator; all durability lives in the queue + `runJob`.

```ts
export type JobHandler = (job: Job, ctx: RunJobContext) => Promise<void>;

export interface JobRunnerDeps {
  queue: JobQueue;
  leaseOwner: string;                       // stable per process (e.g. `serve:${pid}`)
  handlers: Map<string, JobHandler>;        // jobType -> handler
  maxPerTick?: number;                      // claims processed per drainOnce (default 32)
  leaseMs?: number;
  maxConcurrentPerClass?: Record<string, number>;
  onOutcome?: (type: string, outcome: "complete" | "retrying" | "failed" | "lease-lost") => void;
}

export function makeJobRunner(deps: JobRunnerDeps): {
  drainOnce: (signal: AbortSignal) => Promise<void>;
};
```

`drainOnce`: loop up to `maxPerTick` — `queue.claim({ leaseOwner, types: [...handlers.keys()], leaseMs, maxConcurrentPerClass })`; on `null`, stop (queue drained / concurrency saturated); else `await runJob(queue, job, leaseOwner, handlers.get(job.type)!)` and report `onOutcome`. Honors the `signal` (abort between claims on shutdown). Registered on the `Scheduler` as one job (`name: "job-queue-runner"`), reusing the scheduler's single-flight guard, backoff, and bounded-stop — exactly as `contradiction-drain` is registered today.

v1 is serial-per-tick (claim → runJob → repeat); cross-tick concurrency is bounded by `maxConcurrentPerClass`. Intra-tick concurrency is a deliberate follow-up (the contradiction handler already windows its own judge calls at `JUDGE_CONCURRENCY`).

### 2. Contradiction workload

- **Producer** — the index-on-write `onIndexed` hook (`cli.ts` ~line 1030) replaces `contradictionQueue.push({vaultId, chunk})` with:
  ```ts
  jobQueue.enqueue("contradiction", {
    class: "contradiction",
    payload: { vaultId, chunk },
    idempotencyKey: `${vaultId}:${chunk.id}`,   // same rapid-reindex dedup groupContradictionQueue gave — now durable
    maxAttempts: 3,
  });
  ```
- **Handler** — `checkContradictions(ctx, vaultId, [chunk])`. Per-chunk is correct: `semanticSearch` finds neighbors from the indexed DB (not the batch), and each chunk retries independently. The handler observes `ctx.signal` (shutdown/cancel/lease-loss) via the existing `mapLimit` loop.
- **Removes** — `contradictionQueue` array, `makeContradictionDrainer`, `contradiction-drain.ts`'s scheduler registration, `CONTRADICTION_QUEUE_MAX`, and `indexHealth.contradictionsDropped` (no drops exist any more). `groupContradictionQueue` remains only if a batch handler wants it (v1 does not — per-chunk jobs).

### 3. Plane consolidation workload

- **Producer** — the interval formerly wired by `registerPlaneScheduler` now enqueues, on each tick:
  ```ts
  jobQueue.enqueue("synthesis", { class: "plane", idempotencyKey: `synthesis:${isoWeek}`, maxAttempts: 1 });
  jobQueue.enqueue("audit",     { class: "plane", idempotencyKey: `audit:${yyyymmdd}`,   maxAttempts: 1 });
  ```
  Idempotency keys keep a slow run from piling up duplicate weekly/daily jobs.
- **Handlers** — `synthesis` → `runSynthesis(jobCtx)`, `audit` → `runAudit(...)`, where `jobCtx` closes over `{ db, roles, now }` (the existing `JobContext`). A generative failure now dead-letters (maxAttempts=1) rather than vanishing.
- **Removes** — `registerPlaneScheduler` + the `SleepTimePlane` timer registration. `SleepTimePlane`/`runJob` job functions stay (reused as handlers).

### 4. Retry / concurrency policy

- `maxAttempts` per enqueue (contradiction 3, plane 1) — the queue already backs off between attempts and dead-letters at the ceiling.
- `maxConcurrentPerClass: { contradiction: <config>, plane: 1 }` — bounds running jobs per class across ticks (plane is serial; contradiction windowed).
- A `jobQueue` config section (defaulted, back-compat): `{ enabled, intervalMs, maxPerTick, leaseSeconds, contradictionConcurrency }`. Gated on the same conditions as today (`roles` present for the generative work; the runner itself only registers when the queue is constructed).

### 5. Observability — `server_health`

- Add `JobQueue.stats()` → `{ queued, running, retrying, failed }` via `SELECT state, COUNT(*) FROM jobs GROUP BY state` (plus oldest-queued age for backlog visibility).
- Surface it in the `server_health` tool (`tools/admin/health.ts`) as a `job_queue` block. A non-zero `failed` (dead-letter) count is the operator's signal that a workload is persistently failing — the exact silent-loss the old `contradictions_dropped` counter hinted at, now durable and inspectable.

### 6. Reachability

Remove the `packages/server/src/scheduler/job-queue.ts` entry from `UNREACHABLE_ALLOWLIST` in `scripts/check-boundaries.mjs`. The boundary gate's stale-allowlist check then *requires* it to be reachable — proving #14 is done. (The gate fails if it's still listed once reachable.)

## Testing

- **Runner** (`job-runner.test.ts`): claims + dispatches by type; unknown type is a no-op-safe skip; `maxPerTick` bounds a tick; a handler that throws → `retrying` below maxAttempts, `failed` at the ceiling (dead-letter); `drainOnce` stops on `null` claim; abort between claims on signal.
- **Contradiction integration**: enqueue two jobs with the same `vault:chunk` key → one job (idempotency); the handler flags a contradiction and completes; a judge failure retries then dead-letters at 3.
- **Plane integration**: a `synthesis` job runs `runSynthesis` and completes; maxAttempts=1 dead-letters on the first failure; idempotency key prevents a duplicate weekly enqueue.
- **stats/health**: `JobQueue.stats()` counts by state; `server_health` surfaces the `job_queue` block; a dead-lettered job shows in `failed`.
- **Adapt existing**: `contradiction-drain.test.ts` (removed/rewritten), any test asserting `contradictions_dropped`.
- Gate: `bun run lint` + root `bun run typecheck` (all packages) + full server suite green; boundary gate green with the allowlist entry removed.

## Delivery

This is a subsystem refactor of `cli.ts`'s background-work wiring (two timer registrations + an in-memory queue → enqueue + one runner). The JobQueue primitives being complete de-risks it, but it touches the live serve path.

- Isolated **git worktree** off `main`.
- **spec → writing-plans → subagent-driven implementation** (like the P0s), with an adversarial review before merge (it changes the serve-path background execution model).
- Suggested task order: (1) generic runner + tests; (2) `JobQueue.stats()` + `server_health` block; (3) contradiction producer+handler, remove the in-memory drain; (4) plane producer+handlers, remove `registerPlaneScheduler`; (5) remove the reachability allowlist entry + config section; (6) full gate + PR.

## Risks / notes

- **Serve-path behavior change.** Background execution moves from two bespoke timers to one durable runner. Mitigate with the adversarial review + integration tests covering enqueue→run→complete, retry, dead-letter, and idempotency.
- **Per-chunk DB write.** Full-durable adds one `jobs` INSERT per indexed chunk; cheap vs the gateway judge it precedes, and it eliminates the silent-drop failure mode. Bounded by the index-on-write coordinator that already gates chunk throughput.
- **Cache.db growth.** `complete`d/`failed` job rows accumulate. **Out of scope for #14** — a bounded retention sweep (drop `complete` rows older than N days; keep `failed` for inspection, folded into the existing maintenance sweep) is a tracked follow-up. Growth is slow (one row per chunk-index / weekly job) and `server_health` surfaces the counts, so deferring is safe; the follow-up ticket is filed when #14 lands.
- **`jobs` table already exists** — no migration; no checksum risk.
