// THE-462 — unified background scheduler. Folds the four independent unref'd setInterval timers
// (maintenance sweep, plane consolidation, activation recompute, contradiction drain) into ONE
// unref'd tick loop. Each job keeps its exact run body and error/skip routing; the scheduler adds:
//   - single-flight per job (a due tick for an in-flight job is skipped, not overlapped),
//   - budget deferral (defer due ticks while the event-loop delay p99 is high, so background work
//     never starves interactive dispatch),
//   - durable last-success / next-run persistence (opt-in via a Database) with exponential backoff
//     on consecutive failures, and
//   - bounded cancellation (stop() aborts the in-flight run's AbortSignal and awaits settle under a
//     deadline).
//
// Scheduling is driven by the timer's OWN advancement (a virtual clock incremented by each armed
// delay), NOT by `now()`. `now()` is used ONLY for durable timestamps — so callers/tests may pin it
// to a constant without freezing the schedule. Jobs are GLOBAL today (the four are not per-vault);
// per-vault fairness is intentionally a no-op hook — see `selectDue`.
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Database } from "../db/types";

export interface JobSpec {
  /** Unique job name. */
  name: string;
  intervalMs: number;
  /** Run body. Receives the scheduler's AbortSignal (aborted by stop()). Sync or async. */
  run: (signal: AbortSignal) => void | Promise<void>;
  /** Higher runs first when several jobs are due on the same tick (default 0). */
  priority?: number;
  /** 0..1: randomize each next-run by ±ratio to spread load (default 0 — no jitter). */
  jitterRatio?: number;
  /** Called at the start of each run. */
  onRun?: () => void;
  /** A due tick skipped because this job's prior run is still in flight; arg is the running count. */
  onSkip?: (skipped: number) => void;
  /** Error sink; guarded so it can never throw out of the scheduler. */
  onError?: (e: unknown) => void;
}

export interface SchedulerOptions {
  /** Wall-clock source for DURABLE timestamps only (never for scheduling). Default Date.now. */
  now?: () => number;
  /** When provided, per-job {last_run_at,last_success_at,next_run_at,consecutive_failures} persist
   *  to a `job_schedule` table (created IF NOT EXISTS). */
  db?: Database;
  /** Defer due ticks while the event-loop delay p99 (ms) exceeds this. Undefined -> deferral off. */
  eventLoopDeferMs?: number;
  /** Cap for exponential backoff on consecutive failures (default 5 min). */
  maxBackoffMs?: number;
  /** Test seam: event-loop delay p99 in ms. Overrides the real perf_hooks monitor when provided. */
  loopDelayMs?: () => number;
  /** Test seam: RNG in [0,1) for jitter. Default Math.random. */
  random?: () => number;
  /** How long to wait, on stop(), for in-flight runs to settle before clearing (default 5s). */
  shutdownDeadlineMs?: number;
  /** How long a deferred tick waits before re-checking the event-loop budget (default 250ms). */
  deferralRecheckMs?: number;
}

interface JobState {
  spec: JobSpec;
  /** Virtual-clock time (ms) of this job's next due tick. */
  nextRunAt: number;
  /** The in-flight run's promise, or null when idle / running synchronously. */
  inFlight: Promise<void> | null;
  consecutiveFailures: number;
  skipped: number;
}

const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000;
const DEFAULT_SHUTDOWN_DEADLINE_MS = 5000;
const DEFAULT_DEFERRAL_RECHECK_MS = 250;

function isThenable(v: unknown): v is Promise<void> {
  return typeof (v as { then?: unknown } | null | undefined)?.then === "function";
}

export class Scheduler {
  private readonly jobs = new Map<string, JobState>();
  private readonly now: () => number;
  private readonly db?: Database;
  private readonly eventLoopDeferMs?: number;
  private readonly maxBackoffMs: number;
  private readonly random: () => number;
  private readonly shutdownDeadlineMs: number;
  private readonly deferralRecheckMs: number;
  private readonly loopDelay?: () => number;
  /** perf_hooks histogram backing the default loop-delay source; disabled on stop(). */
  private loopMonitor?: { percentile(p: number): number; enable(): void; disable(): void };

  private timer: ReturnType<typeof setTimeout> | null = null;
  private virtualNow = 0;
  private started = false;
  private stopped = false;
  private abort = new AbortController();

  constructor(opts: SchedulerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.db = opts.db;
    this.eventLoopDeferMs = opts.eventLoopDeferMs;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.random = opts.random ?? Math.random;
    this.shutdownDeadlineMs = opts.shutdownDeadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS;
    this.deferralRecheckMs = opts.deferralRecheckMs ?? DEFAULT_DEFERRAL_RECHECK_MS;
    // Budget deferral needs a delay source only when a threshold is set. Prefer the injected seam;
    // otherwise attach the real event-loop-delay monitor (lazily, so no cost when deferral is off).
    if (this.eventLoopDeferMs !== undefined) {
      if (opts.loopDelayMs) {
        this.loopDelay = opts.loopDelayMs;
      } else {
        try {
          // Created only when deferral is actually enabled (a threshold is set and no seam given).
          const h = monitorEventLoopDelay({ resolution: 20 });
          h.enable();
          this.loopMonitor = h;
          this.loopDelay = () => h.percentile(99) / 1e6; // ns -> ms
        } catch {
          /* monitor unavailable -> deferral stays inert (never defers) */
        }
      }
    } else if (opts.loopDelayMs) {
      this.loopDelay = opts.loopDelayMs;
    }
    if (this.db) this.ensureTable(this.db);
  }

  register(spec: JobSpec): this {
    if (this.jobs.has(spec.name)) throw new Error(`scheduler: duplicate job '${spec.name}'`);
    this.jobs.set(spec.name, {
      spec,
      nextRunAt: 0,
      inFlight: null,
      consecutiveFailures: 0,
      skipped: 0,
    });
    return this;
  }

  /** Arm the single unref'd timer. Each job's first due tick is one interval out, unless a stored
   *  next_run_at seeds it. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const state of this.jobs.values()) {
      const seeded = this.seedNextRun(state);
      state.nextRunAt = seeded ?? this.virtualNow + this.effInterval(state);
    }
    this.arm();
  }

  /** Clear the timer, abort the in-flight run(s), await settle under the bounded deadline. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.abort.abort();
    const pending = [...this.jobs.values()]
      .map((s) => s.inFlight)
      .filter((p): p is Promise<void> => !!p);
    if (pending.length > 0) {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((resolve) => {
          setTimeout(resolve, this.shutdownDeadlineMs).unref?.();
        }),
      ]);
    }
    this.loopMonitor?.disable();
  }

  // --- internals -------------------------------------------------------------

  private ensureTable(db: Database): void {
    try {
      db.exec(
        "CREATE TABLE IF NOT EXISTS job_schedule (name TEXT PRIMARY KEY, last_run_at INTEGER, last_success_at INTEGER, next_run_at INTEGER, consecutive_failures INTEGER NOT NULL DEFAULT 0)",
      );
    } catch {
      /* persistence is best-effort: a table failure must never disable scheduling */
    }
  }

  /** Seed a job's first virtual due time from a stored next_run_at (relative to now()), or null. */
  private seedNextRun(state: JobState): number | null {
    if (!this.db) return null;
    try {
      const row = this.db
        .prepare("SELECT next_run_at, consecutive_failures FROM job_schedule WHERE name = ?")
        .get(state.spec.name) as
        | { next_run_at: number | null; consecutive_failures: number | null }
        | undefined;
      if (!row) return null;
      if (row.consecutive_failures != null) state.consecutiveFailures = row.consecutive_failures;
      if (row.next_run_at == null) return null;
      const delay = Math.max(0, row.next_run_at - this.now());
      return this.virtualNow + delay;
    } catch {
      return null;
    }
  }

  /** Interval for the NEXT run: base * 2^failures (capped), with optional ±jitter. */
  private effInterval(state: JobState): number {
    const base = Math.min(
      state.spec.intervalMs * 2 ** state.consecutiveFailures,
      this.maxBackoffMs,
    );
    const ratio = state.spec.jitterRatio ?? 0;
    if (ratio <= 0) return base;
    const jittered = base + base * ratio * (2 * this.random() - 1);
    return Math.max(1, Math.round(jittered));
  }

  /** Idempotent: clears any pending timer before arming. Callable from anywhere — including the
   *  async settle path, where a revised nextRunAt must supersede a timer the tick already armed.
   *  Without the clear, a second arm() would leave TWO live timers and double-tick every job. */
  private arm(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.stopped || this.jobs.size === 0) return;
    let soonest = Number.POSITIVE_INFINITY;
    for (const state of this.jobs.values()) soonest = Math.min(soonest, state.nextRunAt);
    if (!Number.isFinite(soonest)) return;
    const delay = Math.max(0, soonest - this.virtualNow);
    this.timer = setTimeout(() => this.tick(delay), delay);
    this.timer.unref?.();
  }

  private tick(elapsed: number): void {
    if (this.stopped) return;
    this.virtualNow += elapsed;
    const due = this.selectDue();

    // Budget deferral: while the event-loop delay p99 exceeds the threshold, DEFER this cycle's due
    // jobs (reschedule a short recheck out) so background work never starves interactive dispatch.
    if (this.eventLoopDeferMs !== undefined && this.loopDelay && due.length > 0) {
      if (this.loopDelay() > this.eventLoopDeferMs) {
        for (const state of due) state.nextRunAt = this.virtualNow + this.deferralRecheckMs;
        this.arm();
        return;
      }
    }

    for (const state of due) {
      if (state.inFlight) {
        state.skipped += 1;
        this.safeSkip(state);
        state.nextRunAt = this.virtualNow + this.effInterval(state);
        continue;
      }
      // Provisional schedule, set BEFORE dispatch so a still-running async job cannot be
      // re-dispatched. onSuccess/onFailure revise it authoritatively once the outcome is known —
      // which is the whole point: computed here, the interval cannot reflect a failure that has
      // not happened yet. Assigning before the run also keeps the SYNCHRONOUS path correct, where
      // onSuccess/onFailure already ran inside runJob and would otherwise be clobbered.
      state.nextRunAt = this.virtualNow + this.effInterval(state);
      this.runJob(state);
    }
    this.arm();
  }

  /** Due jobs, highest priority first. Per-vault fairness is a documented no-op: the four current
   *  jobs are GLOBAL, so there is no per-vault queue to round-robin. When per-vault jobs land, this
   *  is the seam to interleave them fairly. */
  private selectDue(): JobState[] {
    const due: JobState[] = [];
    for (const state of this.jobs.values()) {
      if (state.nextRunAt <= this.virtualNow) due.push(state);
    }
    due.sort((a, b) => (b.spec.priority ?? 0) - (a.spec.priority ?? 0));
    return due;
  }

  private runJob(state: JobState): void {
    this.safeRun(state);
    this.persistRunStart(state);
    let ret: void | Promise<void>;
    try {
      ret = state.spec.run(this.abort.signal);
    } catch (e) {
      this.onFailure(state, e); // synchronous throw
      return;
    }
    if (isThenable(ret)) {
      state.inFlight = ret.then(
        () => this.onSuccess(state),
        (e) => this.onFailure(state, e),
      );
      // Clear the in-flight marker once settled (both branches above already handled outcome).
      state.inFlight = state.inFlight.finally(() => {
        state.inFlight = null;
      });
    } else {
      this.onSuccess(state); // synchronous completion
    }
  }

  private onSuccess(state: JobState): void {
    state.consecutiveFailures = 0;
    // Recovery must shorten the in-memory schedule too, not just the durable row — otherwise a
    // job that recovers stays on its backed-off interval until the process restarts.
    state.nextRunAt = this.virtualNow + this.effInterval(state);
    this.arm(); // the tick armed against the provisional value; supersede it
    if (!this.db) return;
    const t = this.now();
    this.persist(state, {
      last_success_at: t,
      next_run_at: t + this.effInterval(state),
      consecutive_failures: 0,
    });
  }

  private onFailure(state: JobState, e: unknown): void {
    state.consecutiveFailures += 1;
    // Re-derive AFTER the increment. The provisional value set at dispatch was computed from the
    // pre-failure count, so without this the first retry after each failure arrives one backoff
    // step early.
    state.nextRunAt = this.virtualNow + this.effInterval(state);
    this.arm(); // the tick armed against the provisional value; supersede it
    if (this.db) {
      const t = this.now();
      this.persist(state, {
        next_run_at: t + this.effInterval(state),
        consecutive_failures: state.consecutiveFailures,
      });
    }
    this.safeError(state, e);
  }

  /** Run-start persist: writes ONLY last_run_at/next_run_at. This is a separate statement (not a
   *  call into persist()) because it must NEVER touch consecutive_failures — not even to "leave it
   *  alone" via a bound NULL. SQLite's DEFAULT does not apply to an explicit NULL, and a bound NULL
   *  into `consecutive_failures INTEGER NOT NULL` fails the NOT NULL check before the ON CONFLICT
   *  COALESCE ever runs (on both a fresh row and an existing one). Omitting the column entirely lets
   *  a fresh row seed from DEFAULT 0, and the DO UPDATE simply never mentions the column, so an
   *  existing row's backoff counter survives every run-start untouched. */
  private persistRunStart(state: JobState): void {
    if (!this.db) return;
    const t = this.now();
    try {
      this.db
        .prepare(
          `INSERT INTO job_schedule (name, last_run_at, next_run_at)
           VALUES (@name, @last_run_at, @next_run_at)
           ON CONFLICT(name) DO UPDATE SET
             last_run_at = excluded.last_run_at,
             next_run_at = excluded.next_run_at`,
        )
        .run({
          name: state.spec.name,
          last_run_at: t,
          next_run_at: t + this.effInterval(state),
        });
    } catch {
      /* durable scheduling is best-effort: a write failure must never break the timer loop */
    }
  }

  private persist(
    state: JobState,
    fields: Partial<{
      last_run_at: number;
      last_success_at: number;
      next_run_at: number;
      consecutive_failures: number;
    }>,
  ): void {
    if (!this.db) return;
    try {
      // Upsert the touched columns; unspecified columns retain their stored value via COALESCE on
      // the excluded row (INSERT supplies NULLs for the untouched ones).
      this.db
        .prepare(
          `INSERT INTO job_schedule (name, last_run_at, last_success_at, next_run_at, consecutive_failures)
           VALUES (@name, @last_run_at, @last_success_at, @next_run_at, @consecutive_failures)
           ON CONFLICT(name) DO UPDATE SET
             last_run_at = COALESCE(excluded.last_run_at, job_schedule.last_run_at),
             last_success_at = COALESCE(excluded.last_success_at, job_schedule.last_success_at),
             next_run_at = COALESCE(excluded.next_run_at, job_schedule.next_run_at),
             consecutive_failures = COALESCE(excluded.consecutive_failures, job_schedule.consecutive_failures)`,
        )
        .run({
          name: state.spec.name,
          last_run_at: fields.last_run_at ?? null,
          last_success_at: fields.last_success_at ?? null,
          next_run_at: fields.next_run_at ?? null,
          consecutive_failures: fields.consecutive_failures ?? null,
        });
    } catch {
      /* durable scheduling is best-effort: a write failure must never break the timer loop */
    }
  }

  private safeRun(state: JobState): void {
    try {
      state.spec.onRun?.();
    } catch {
      /* onRun sink must never throw */
    }
  }

  private safeSkip(state: JobState): void {
    try {
      state.spec.onSkip?.(state.skipped);
    } catch {
      /* skip sink must never throw */
    }
  }

  private safeError(state: JobState, e: unknown): void {
    try {
      state.spec.onError?.(e);
    } catch {
      /* error sink must never throw */
    }
  }
}
