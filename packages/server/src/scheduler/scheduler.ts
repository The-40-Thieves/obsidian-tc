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
  /** THE-666: fired when a durable-persistence write/read fails (ensureTable, seedNextRun,
   *  persistRunStart, persist). Same "error channel" shape as `JobSpec.onError` and
   *  `makeActivationLookup`'s `onError` (THE-653) — guarded so it can never throw out of the
   *  scheduler, and never changes the best-effort contract: persistence stays disabled for that
   *  write, scheduling continues regardless. Throttled — see `reportPersistError`. */
  onPersistError?: (failure: SchedulerPersistFailure) => void;
}

/** THE-666: one occurrence of a persistence op failing. `job` is absent for `ensureTable`, which
 *  runs once at construction, before any job exists, and whose failure is process-wide rather
 *  than job-scoped (every subsequent seedNextRun/persistRunStart/persist call is also doomed,
 *  since job_schedule was never created). */
export interface SchedulerPersistFailure {
  op: "ensureTable" | "seedNextRun" | "persistRunStart" | "persist";
  job?: string;
  error: unknown;
}

interface JobState {
  spec: JobSpec;
  /** Virtual-clock time (ms) of this job's next due tick. */
  nextRunAt: number;
  /** The in-flight run's promise, or null when idle / running synchronously. */
  inFlight: Promise<void> | null;
  consecutiveFailures: number;
  skipped: number;
  /** THE-585 (#9): due ticks deferred (not skipped) by budget deferral — see the tick() branch
   *  below. Inert (stays 0 forever) unless `eventLoopDeferMs` is configured. */
  deferred: number;
}

const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000;
const DEFAULT_SHUTDOWN_DEADLINE_MS = 5000;
const DEFAULT_DEFERRAL_RECHECK_MS = 250;

function isThenable(v: unknown): v is Promise<void> {
  return typeof (v as { then?: unknown } | null | undefined)?.then === "function";
}

export class Scheduler {
  private readonly jobs = new Map<string, JobState>();

  /** THE-585 (#9): live per-job health for the metrics gauges. A SNAPSHOT accessor rather than a
   *  push into a recorder, matching the query-cache precedent — the scheduler already owns both
   *  numbers, and a Counter would make it call INTO the metrics layer, inverting the composition
   *  root's one-way dependency.
   *
   *  `job` labels are bounded: they are the registered job NAMES, all defined in code at startup,
   *  never derived from a request. `onSkip` already reported skips, but only as a callback fired at
   *  the moment of a skip — nothing accumulated it anywhere a scrape could read. */
  stats(): Array<{
    job: string;
    skipped: number;
    consecutiveFailures: number;
    deferred: number;
  }> {
    return [...this.jobs.entries()].map(([job, st]) => ({
      job,
      skipped: st.skipped,
      consecutiveFailures: st.consecutiveFailures,
      deferred: st.deferred,
    }));
  }
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
  private readonly onPersistError?: (failure: SchedulerPersistFailure) => void;
  /** THE-666: dedup keys (`${op}:${job ?? ""}`) already reported to onPersistError. Cleared for a
   *  job's write ops on their next SUCCESS, so a failure that recovers and later recurs alerts
   *  again — this is not a one-shot-forever suppression, it is "one alert per failure streak". */
  private readonly persistErrorSeen = new Set<string>();

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
    this.onPersistError = opts.onPersistError;
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
      deferred: 0,
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

  /** THE-666: every persistence catch below used to discard its error with nothing outside the
   *  process — no log, no counter, no health signal, so a broken `job_schedule` table and a
   *  healthy one were byte-identical from outside. This reports it through the guarded
   *  `onPersistError` channel (same shape as `JobSpec.onError`), throttled to ONE call per
   *  distinct (op, job) pair since the last success: the scheduler ticks continuously (the
   *  job-queue-runner alone is every 15s in production, see cli.ts), so an unthrottled callback
   *  on every failed write would itself become a log flood. One alert per failure streak is
   *  enough to page an operator; it does not change the best-effort contract — scheduling is
   *  unaffected either way. */
  private reportPersistError(
    op: SchedulerPersistFailure["op"],
    job: string | undefined,
    error: unknown,
  ): void {
    const key = `${op}:${job ?? ""}`;
    if (this.persistErrorSeen.has(key)) return;
    this.persistErrorSeen.add(key);
    try {
      this.onPersistError?.({ op, job, error });
    } catch {
      /* persist-error sink must never throw */
    }
  }

  /** Clears a (op, job) key's dedup entry on a SUCCESSFUL write, so a later failure — a new
   *  streak, not a continuation of the one already reported — alerts again instead of staying
   *  silent forever after the first occurrence. */
  private clearPersistError(op: SchedulerPersistFailure["op"], job: string): void {
    this.persistErrorSeen.delete(`${op}:${job}`);
  }

  private ensureTable(db: Database): void {
    try {
      // THE-715: `name` is NOT NULL as well as PRIMARY KEY, and the redundancy is load-bearing.
      // SQLite does NOT enforce NOT NULL on a PRIMARY KEY column unless the table is WITHOUT
      // ROWID — a long-standing documented quirk kept for backward compatibility — so `name TEXT
      // PRIMARY KEY` alone admits unlimited NULL rows. Every UPSERT with a null name therefore
      // INSERTED instead of updating, and this table accumulated 2,979 orphan rows against 7 real
      // ones before THE-665 stopped the writer producing them.
      //
      // This is CREATE TABLE IF NOT EXISTS, so the constraint only reaches databases created from
      // here on. An existing store keeps the permissive schema forever, which is why the
      // maintenance sweep also prunes NULL-name rows (db/maintenance.ts) rather than this being a
      // one-line DDL fix. Both halves are needed: the constraint stops new stores from ever
      // reaching that state, the sweep repairs the ones already in it.
      db.exec(
        "CREATE TABLE IF NOT EXISTS job_schedule (name TEXT NOT NULL PRIMARY KEY, last_run_at INTEGER, last_success_at INTEGER, next_run_at INTEGER, consecutive_failures INTEGER NOT NULL DEFAULT 0)",
      );
    } catch (err) {
      // THE-666: persistence is best-effort: a table failure must never disable scheduling — but
      // it DOES mean every persist below is dead for the rest of the process (there is no retry
      // of ensureTable), a materially different condition from one write failing. Reported without
      // a `job` (this runs once, at construction, before any job is registered).
      this.reportPersistError("ensureTable", undefined, err);
    }
  }

  /** Seed a job's first virtual due time from a stored next_run_at (relative to now()), or null.
   *
   *  THE-666: `null` means two very different things — no stored row (a fresh install; correctly
   *  silent, every job starts that way once) and a read that THREW (a corrupt/unreadable
   *  job_schedule; the scheduler responds by reseeding every job from scratch on every restart,
   *  masquerading as a fresh install forever). Both must still fall back to the same schedule —
   *  reseeding from `intervalMs` is the only safe move when the stored value cannot be trusted
   *  either way, so the RETURN VALUE stays collapsed to `null` on purpose (start() cannot act on
   *  the difference and must not throw). What was missing was a CHANNEL: the catch branch below
   *  now reports through `onPersistError`, so a persistent read failure is distinguishable from a
   *  cold cache from OUTSIDE the process, even though in-process behaviour is identical either
   *  way — same distinction THE-653's `makeActivationLookup` drew for a cache miss vs. a read
   *  failure, carried through a side channel instead of the return type for the same reason: this
   *  call site can't widen its contract without changing what "no seed" means for every caller. */
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
    } catch (err) {
      this.reportPersistError("seedNextRun", state.spec.name, err);
      return null;
    }
  }

  /** Interval for the NEXT run: base * 2^failures (capped), with optional ±jitter.
   *
   * THE-723: the cap bounds the BACKOFF and must never pull a run EARLIER than the job's own
   * interval. This was `Math.min(intervalMs * 2 ** failures, maxBackoffMs)`, which is only a
   * backoff cap while `intervalMs <= maxBackoffMs`. Above that it silently inverts into a GLOBAL
   * CEILING: with `failures = 0` it reduces to `min(intervalMs, maxBackoffMs)`, and effInterval
   * computes every next-run — including the success path — so every job slower than the 5-minute
   * default ran every 5 minutes instead of on its configured interval. Measured on the live store
   * 2026-08-04: `plane` is configured at 240 minutes and `audit_reports` carried one row per
   * 5 minutes (243 in a day against the ~6 its interval implies). `maintenance` (60m), the gap
   * sweep (hours) and reconcile were clamped the same way.
   *
   * It survived because every scheduler test registers `intervalMs: 1000` — a full ceiling below
   * the cap, where `Math.min` always picks the interval and the clamp cannot fire. A backoff cap
   * shorter than the base interval does not slow a failing job down; it speeds every slow job up.
   */
  private effInterval(state: JobState): number {
    const backoff = Math.min(
      state.spec.intervalMs * 2 ** state.consecutiveFailures,
      this.maxBackoffMs,
    );
    const base = Math.max(backoff, state.spec.intervalMs);
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
        for (const state of due) {
          state.nextRunAt = this.virtualNow + this.deferralRecheckMs;
          state.deferred += 1;
        }
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
      // THE-665: positional `?` binds, not named `@param` object binds — bun:sqlite accepts a
      // bare-key object without throwing but silently binds every column to NULL (see
      // db/bun-sqlite.ts and the conformance test in test/param-binding.test.ts).
      this.db
        .prepare(
          `INSERT INTO job_schedule (name, last_run_at, next_run_at)
           VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             last_run_at = excluded.last_run_at,
             next_run_at = excluded.next_run_at`,
        )
        .run(state.spec.name, t, t + this.effInterval(state));
      this.clearPersistError("persistRunStart", state.spec.name);
    } catch (err) {
      // THE-666: durable scheduling is best-effort: a write failure must never break the timer
      // loop — but it must not be INVISIBLE either. Throttled inside reportPersistError.
      this.reportPersistError("persistRunStart", state.spec.name, err);
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
      // THE-665: positional `?` binds, not named `@param` object binds — bun:sqlite accepts a
      // bare-key object without throwing but silently binds every column to NULL (see
      // db/bun-sqlite.ts and the conformance test in test/param-binding.test.ts).
      this.db
        .prepare(
          `INSERT INTO job_schedule (name, last_run_at, last_success_at, next_run_at, consecutive_failures)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             last_run_at = COALESCE(excluded.last_run_at, job_schedule.last_run_at),
             last_success_at = COALESCE(excluded.last_success_at, job_schedule.last_success_at),
             next_run_at = COALESCE(excluded.next_run_at, job_schedule.next_run_at),
             consecutive_failures = COALESCE(excluded.consecutive_failures, job_schedule.consecutive_failures)`,
        )
        .run(
          state.spec.name,
          fields.last_run_at ?? null,
          fields.last_success_at ?? null,
          fields.next_run_at ?? null,
          fields.consecutive_failures ?? null,
        );
      this.clearPersistError("persist", state.spec.name);
    } catch (err) {
      // THE-666: durable scheduling is best-effort: a write failure must never break the timer
      // loop — but it must not be INVISIBLE either. Throttled inside reportPersistError.
      this.reportPersistError("persist", state.spec.name, err);
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
