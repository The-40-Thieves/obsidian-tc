// THE-517 — durable job queue. Extends THE-462's insight (durable retry/backoff state is the
// only truth) from the four NAMED periodic sweeps in `job_schedule` to per-INSTANCE queued work:
// index jobs, model-request jobs, bridge ops — anything with its own payload, attempt history,
// and lifetime, rather than a recurring tick.
//
// The whole point of this module is that there is NO in-memory retry/attempt/lease state
// anywhere. Every method reads and writes the `jobs` row directly; a crashed process leaves
// nothing behind to diverge from the database, because nothing was ever cached outside it. The
// only "state" JobQueue instances hold is the db handle, the clock, and defaults — never a Job.
//
// Crash recovery: `claim()` reclaims a job whose lease has expired (state='running' AND
// lease_expires_at <= now) exactly as if it were freshly queued. The reclaim scan runs inside a
// BEGIN IMMEDIATE transaction, which takes SQLite's write lock for the connection's whole
// candidate-scan + UPDATE — so two callers (in-process or cross-process, sharing one file under
// WAL) can never both claim the same row: the second's BEGIN IMMEDIATE blocks until the first
// commits, and by then the row's state/lease_owner have already moved.
import { randomUUID } from "node:crypto";
import { inWriteTransaction, type WriteTxnHooks } from "../db/txn";
import type { Database } from "../db/types";

export type JobState = "queued" | "running" | "retrying" | "complete" | "failed";

/**
 * THE-583: what a task-augmented call produced, as a TAGGED union.
 *
 * Exclusive by construction: a row cannot be both a success and a failure, and cannot be neither
 * while claiming an outcome. Two nullable columns would admit both of those states with nothing to
 * reject them. NULL on the row (not a `JobOutcome`) is the third, meaningful case: no outcome yet.
 */
export type JobOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: { code: number; message: string } };

/**
 * Read an outcome envelope back off the row.
 *
 * Returns null on anything unreadable rather than throwing. A malformed envelope must not make the
 * whole job unreadable — `tasks/get` would start answering "unknown task" for a job that plainly
 * exists, which is a far worse failure than a missing result field.
 */
function parseOutcome(raw: string | null | undefined): JobOutcome | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const v = JSON.parse(raw) as JobOutcome;
    if (v !== null && typeof v === "object" && typeof (v as { ok?: unknown }).ok === "boolean") {
      return v;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export interface Job {
  id: string;
  type: string;
  class: string;
  state: JobState;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: number | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  cancelRequested: boolean;
  checkpoint: unknown;
  payload: unknown;
  idempotencyKey: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  /** THE-583: the vault this job was enqueued FOR, when a caller asked for it. NULL for internal
   *  maintenance work, which is what makes such jobs invisible to the MCP Tasks extension. */
  vaultId: string | null;
  /** THE-583: the principal that asked for it; NULL alongside `vaultId` for internal work. */
  caller: string | null;
  /**
   * THE-583: the tagged outcome envelope for a task-augmented call, or NULL when none was recorded
   * (still working, or internal work that never has one). See 20260728_002_jobs_outcome.sql.
   */
  outcome: JobOutcome | null;
}

interface JobRow {
  id: string;
  type: string;
  class: string;
  state: JobState;
  attempt: number;
  max_attempts: number;
  next_attempt_at: number | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  cancel_requested: number;
  checkpoint: string | null;
  payload: string | null;
  idempotency_key: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  vault_id: string | null;
  caller: string | null;
  outcome: string | null;
}

function fromRow(row: JobRow): Job {
  return {
    id: row.id,
    type: row.type,
    class: row.class,
    state: row.state,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    cancelRequested: row.cancel_requested !== 0,
    checkpoint: row.checkpoint == null ? undefined : JSON.parse(row.checkpoint),
    payload: row.payload == null ? undefined : JSON.parse(row.payload),
    idempotencyKey: row.idempotency_key,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    vaultId: row.vault_id ?? null,
    caller: row.caller ?? null,
    outcome: parseOutcome(row.outcome),
  };
}

export interface EnqueueOptions {
  /** THE-583: enqueue on a CALLER's behalf, making the job visible as an MCP task to that caller
   *  and no one else. Omit for internal maintenance work — the default is invisible. */
  owner?: { vaultId: string; caller: string | null };
  /** Bounded-concurrency bucket; defaults to `type`. */
  class?: string;
  maxAttempts?: number;
  /** Enqueuing twice with the same key returns the FIRST job unchanged — enqueue is a no-op. */
  idempotencyKey?: string;
  payload?: unknown;
  /** #14: when set, an existing keyed row in a TERMINAL state (complete/failed) is replaced by a
   *  fresh queued job rather than deduped against. An ACTIVE row (queued/running/retrying) still
   *  dedups — the in-flight double-work guard is preserved. Off by default so the plane's
   *  once-per-period dedup (a completed weekly synthesis must block re-runs) is unaffected.
   *  Needed for content-keyed jobs (contradiction): the indexer deletes a re-embedded chunk's
   *  flags and relies on the re-enqueue to regenerate them, so a finished/dead-lettered job must
   *  not permanently block re-judging recurring identical content. */
  replaceIfTerminal?: boolean;
}

export interface ClaimOptions {
  leaseOwner: string;
  /** Restrict claim to these job types. Undefined -> any type. */
  types?: string[];
  leaseMs?: number;
  /** Max concurrently RUNNING (lease-alive) jobs per class. Absent class key -> unbounded. */
  classLimits?: Record<string, number>;
}

export interface JobQueueOptions {
  now?: () => number;
  leaseMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  maxBackoffMs?: number;
  /** THE-585 (#5): write-lock observability for `claim()`. Additive and best-effort; absent in
   *  tests and anywhere no MetricsRecorder exists. */
  sql?: WriteTxnHooks;
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000;
// How many due candidates claim() scans before giving up on this cycle when class limits are in
// play. A due job whose class is at capacity is skipped in favor of the next; this bounds that
// scan so a queue full of one saturated class can't make claim() scan unboundedly.
const CLAIM_SCAN_LIMIT = 50;

export class JobQueue {
  /** THE-583: `notifications/tasks` subscribers. Empty in every deployment that never opens one. */
  private readonly taskListeners = new Set<(job: Job) => void>();

  private readonly db: Database;
  private readonly now: () => number;
  private readonly leaseMsValue: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly maxBackoffMs: number;
  private readonly sql: WriteTxnHooks | undefined;

  constructor(db: Database, opts: JobQueueOptions = {}) {
    this.sql = opts.sql;
    this.db = db;
    this.now = opts.now ?? Date.now;
    this.leaseMsValue = opts.leaseMs ?? DEFAULT_LEASE_MS;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  }

  /** THE-517: read-only view of this instance's configured default lease duration. Exists so
   *  runJob can derive its heartbeat default from the SAME queue's actual leaseMs instead of a
   *  hardcoded constant that could outlive a caller-supplied short lease (see runJob below). */
  get leaseMs(): number {
    return this.leaseMsValue;
  }

  /** Backoff for the Nth retry (1-indexed attempt count already failed): base * 2^(attempt-1),
   *  capped. Pure function of the persisted attempt count — never of anything held in memory. */
  private backoff(attempt: number): number {
    return Math.min(this.backoffBaseMs * 2 ** Math.max(0, attempt - 1), this.maxBackoffMs);
  }

  enqueue(type: string, opts: EnqueueOptions = {}): Job {
    const t = this.now();
    if (opts.idempotencyKey) {
      const existing = this.db
        .prepare("SELECT * FROM jobs WHERE idempotency_key = ?")
        .get(opts.idempotencyKey) as JobRow | undefined;
      if (existing) {
        const terminal = existing.state === "complete" || existing.state === "failed";
        if (opts.replaceIfTerminal && terminal) {
          // Free the UNIQUE key so a legitimate re-run of recurring content can enqueue. This
          // discards the terminal row (incl. a dead-letter record) for that exact key — acceptable
          // for content-keyed jobs, where re-judging matters more than retaining a stale outcome.
          this.db.prepare("DELETE FROM jobs WHERE id = ?").run(existing.id);
        } else {
          return fromRow(existing); // active row, or dedup-as-before: enqueue is a no-op
        }
      }
    }
    const id = randomUUID();
    const row = {
      id,
      type,
      class: opts.class ?? type,
      max_attempts: opts.maxAttempts ?? this.maxAttempts,
      payload: opts.payload === undefined ? null : JSON.stringify(opts.payload),
      idempotency_key: opts.idempotencyKey ?? null,
      created_at: t,
      updated_at: t,
      // NULL unless a caller asked for this job — see the migration's note on why invisible is the
      // default rather than something a read path has to remember to filter for.
      vault_id: opts.owner?.vaultId ?? null,
      caller: opts.owner?.caller ?? null,
    };
    try {
      // THE-665: positional `?` binds, not named `@param` object binds — bun:sqlite accepts a
      // bare-key object without throwing but silently binds every column to NULL (see
      // db/bun-sqlite.ts and the conformance test in test/param-binding.test.ts). Positional binding
      // is the one form all three adapters (bun:sqlite, node:sqlite, better-sqlite3) apply
      // correctly, so it is the only safe choice for a statement shared across runtimes.
      this.db
        .prepare(
          `INSERT INTO jobs (id, type, class, state, attempt, max_attempts, next_attempt_at, payload, idempotency_key, created_at, updated_at, vault_id, caller)
           VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.type,
          row.class,
          row.max_attempts,
          row.created_at,
          row.payload,
          row.idempotency_key,
          row.created_at,
          row.updated_at,
          row.vault_id,
          row.caller,
        );
    } catch (e) {
      // Two racing enqueues with the same idempotency key: the loser's INSERT hits the unique
      // index; fall back to the winner's row rather than surfacing a constraint error.
      if (opts.idempotencyKey) {
        const winner = this.db
          .prepare("SELECT * FROM jobs WHERE idempotency_key = ?")
          .get(opts.idempotencyKey) as JobRow | undefined;
        if (winner) return fromRow(winner);
      }
      throw e;
    }
    return this.get(id) as Job;
  }

  get(id: string): Job | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? fromRow(row) : null;
  }

  listByState(state: JobState): Job[] {
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE state = ? ORDER BY created_at ASC")
      .all(state) as JobRow[];
    return rows.map(fromRow);
  }

  /** Claim the oldest due job (queued, due-retrying, or lease-expired-running), honoring an
   *  optional per-class concurrency cap. Returns null when nothing is claimable. */
  claim(opts: ClaimOptions): Job | null {
    const t = this.now();
    const leaseMs = opts.leaseMs ?? this.leaseMsValue;
    // THE-585 (#5): already a BEGIN IMMEDIATE — routing it through inWriteTransaction changes no
    // SQL, only who gets told how long the lock took. This is the cross-process contention site,
    // so its samples are the cleanest evidence in the whole catalog.
    return inWriteTransaction(
      this.db,
      "job_claim",
      (): Job | null => {
        const typeFilter = opts.types?.length
          ? `AND type IN (${opts.types.map(() => "?").join(",")})`
          : "";
        const candidates = this.db
          .prepare(
            `SELECT * FROM jobs
           WHERE (
             state = 'queued'
             OR (state = 'retrying' AND next_attempt_at <= ?)
             OR (state = 'running' AND lease_expires_at <= ?)
           )
           ${typeFilter}
           ORDER BY COALESCE(next_attempt_at, created_at) ASC
           LIMIT ?`,
          )
          .all(t, t, ...(opts.types ?? []), CLAIM_SCAN_LIMIT) as JobRow[];

        for (const row of candidates) {
          const limit = opts.classLimits?.[row.class];
          if (limit !== undefined) {
            const running = this.db
              .prepare(
                "SELECT COUNT(*) AS n FROM jobs WHERE class = ? AND state = 'running' AND lease_expires_at > ?",
              )
              .get(row.class, t) as { n: number };
            if (running.n >= limit) continue; // class at capacity: try the next candidate
          }
          const updated = this.db
            .prepare(
              `UPDATE jobs SET state = 'running', attempt = attempt + 1, lease_owner = ?,
               lease_expires_at = ?, updated_at = ? WHERE id = ?`,
            )
            .run(opts.leaseOwner, t + leaseMs, t, row.id);
          if (updated.changes === 1) return this.get(row.id) as Job;
        }
        return null;
      },
      this.sql,
    );
  }

  /** Extend the lease. Fails (returns false) if the caller no longer owns it — an already-reaped
   *  job must not have its old owner clawing the lease back out from under the new one. */
  heartbeat(id: string, leaseOwner: string, leaseMs?: number): boolean {
    const t = this.now();
    const updated = this.db
      .prepare(
        "UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND state = 'running'",
      )
      .run(t + (leaseMs ?? this.leaseMsValue), t, id, leaseOwner);
    return updated.changes === 1;
  }

  /** Persist progress mid-run so a lease-reclaiming worker can resume instead of restarting. */
  checkpoint(id: string, leaseOwner: string, data: unknown): boolean {
    const t = this.now();
    const updated = this.db
      .prepare(
        "UPDATE jobs SET checkpoint = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND state = 'running'",
      )
      .run(JSON.stringify(data), t, id, leaseOwner);
    return updated.changes === 1;
  }

  /**
   * THE-583: persist the outcome of a task-augmented call.
   *
   * Written BEFORE `complete()`, deliberately. A client that polls `tasks/get` and sees `completed`
   * must find the result there — completing first opens a window where the task reports success and
   * the answer it is reporting success for does not exist yet.
   *
   * Not lease-guarded, unlike complete()/fail(): this is the runner recording what it just produced,
   * and a lease lost between here and `complete()` means the write simply does not become visible
   * (the job is not `complete`, so the projection never surfaces the outcome).
   */
  /**
   * THE-583: observe state changes on CALLER-OWNED jobs, for `notifications/tasks`.
   *
   * Only owned jobs are announced. Internal maintenance work (`vault_id IS NULL`) is invisible over
   * MCP by construction, and a change feed that leaked it would undo that in the one place nobody
   * would think to re-check — the same reasoning as findOwnedJob, applied to the push side.
   *
   * Returns an unsubscribe. Listeners are called AFTER the write commits, so a listener that reads
   * the job back sees the state it is being told about rather than the one before it.
   */
  onTaskChange(listener: (job: Job) => void): () => void {
    this.taskListeners.add(listener);
    return () => {
      this.taskListeners.delete(listener);
    };
  }

  /** Announce a change, if the job is caller-owned. Never throws into the caller's write path. */
  private announce(id: string): void {
    if (this.taskListeners.size === 0) return;
    const job = this.get(id);
    // NULL vaultId = internal work: never announced, whoever is listening.
    if (job === null || job.vaultId == null) return;
    for (const listener of [...this.taskListeners]) {
      try {
        listener(job);
      } catch {
        /* a subscriber must never break the queue write that triggered it */
      }
    }
  }

  recordOutcome(id: string, outcome: JobOutcome): void {
    this.db
      .prepare("UPDATE jobs SET outcome = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(outcome), this.now(), id);
    this.announce(id);
  }

  complete(id: string, leaseOwner: string): boolean {
    const t = this.now();
    const updated = this.db
      .prepare(
        "UPDATE jobs SET state = 'complete', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND lease_owner = ? AND state = 'running'",
      )
      .run(t, id, leaseOwner);
    if (updated.changes === 1) this.announce(id);
    return updated.changes === 1;
  }

  /** Record a failed attempt. Below max_attempts (and not `terminal`) -> 'retrying' with backoff;
   *  at/above max_attempts, or an explicitly terminal failure (e.g. cancellation), -> 'failed' —
   *  the dead-letter state. Either way attempt/backoff live ONLY in this row. */
  fail(id: string, leaseOwner: string, error: unknown, opts: { terminal?: boolean } = {}): boolean {
    const t = this.now();
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
    if (!row || row.lease_owner !== leaseOwner || row.state !== "running") return false;
    const message = error instanceof Error ? error.message : String(error);
    const deadLetter = opts.terminal === true || row.attempt >= row.max_attempts;
    const updated = this.db
      .prepare(
        deadLetter
          ? `UPDATE jobs SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL,
               next_attempt_at = NULL, last_error = ?, updated_at = ? WHERE id = ? AND lease_owner = ?`
          : `UPDATE jobs SET state = 'retrying', lease_owner = NULL, lease_expires_at = NULL,
               next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ? AND lease_owner = ?`,
      )
      .run(
        ...(deadLetter
          ? [message, t, id, leaseOwner]
          : [t + this.backoff(row.attempt), message, t, id, leaseOwner]),
      );
    this.announce(id);
    return updated.changes === 1;
  }

  /** Mark cancellation intent. A running worker discovers this cooperatively (poll via
   *  `isCancelRequested`, typically alongside its own heartbeat cadence) and must abort its own
   *  AbortController to actually stop in-flight work — setting this flag alone changes no
   *  in-flight behaviour, by design (see runJob below for the wiring). */
  requestCancel(id: string): boolean {
    const t = this.now();
    const updated = this.db
      .prepare("UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?")
      .run(t, id);
    this.announce(id);
    return updated.changes === 1;
  }

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

  isCancelRequested(id: string): boolean {
    const row = this.db.prepare("SELECT cancel_requested FROM jobs WHERE id = ?").get(id) as
      | { cancel_requested: number }
      | undefined;
    return row?.cancel_requested === 1;
  }
}

export interface RunJobContext {
  signal: AbortSignal;
  checkpoint: (data: unknown) => void;
}

export interface RunJobOptions {
  /** How often to renew the lease / poll cancel_requested while the handler runs. Default
   *  leaseMs/3 so at least two heartbeats land inside one lease window before it could expire. */
  heartbeatMs?: number;
}

/**
 * Execute one claimed job: renews its lease on an interval (so a still-alive worker's job is
 * never reclaimed out from under it), polls cancel_requested each beat and — this is the part
 * that makes cancellation real rather than cosmetic — ABORTS the AbortController backing the
 * handler's signal the moment it sees the flag, so whatever the handler is doing (a model
 * request, a loop over SQLite rows, a bridge call) observes the SAME signal firing and can stop
 * mid-operation. Terminal outcome (complete/retrying/failed) is always driven by the persisted
 * row via queue.complete/fail — never by an in-memory flag.
 *
 * THE-517 follow-up (found in post-merge review, not part of the original ticket): heartbeat(),
 * complete(), and fail() all return `false` when this worker no longer owns the lease — i.e.
 * another worker's claim() already reclaimed the row after this lease expired. The original
 * version of this function discarded every one of those booleans, so a slow worker whose lease
 * had already been reclaimed would keep running the handler to completion and unconditionally
 * report `{ outcome: "complete" }` — duplicate side effects, reported as a clean success.
 *
 * This does NOT give the queue exactly-once semantics — that is an explicit non-goal and remains
 * one. Two workers can still both execute a job's side effects before either notices the lease
 * moved. What changes here is that lease loss becomes VISIBLE: the "lease-lost" outcome tells the
 * caller "this worker's write did not land, do not trust it", instead of silently reporting
 * complete/failed/retrying for work whose persisted outcome disagrees.
 */
export async function runJob(
  queue: JobQueue,
  job: Job,
  leaseOwner: string,
  handler: (job: Job, ctx: RunJobContext) => Promise<void>,
  opts: RunJobOptions = {},
): Promise<{ outcome: "complete" | "retrying" | "failed" | "lease-lost"; error?: unknown }> {
  const controller = new AbortController();
  // THE-517: derive the default from THIS queue's own leaseMs (via the leaseMs getter) rather
  // than a hardcoded constant. A caller configuring a short lease (e.g. `leaseMs: 3_000`) must
  // not get a 5s heartbeat that would fire AFTER the lease already expired — that silently
  // guarantees the first heartbeat always loses the race. The floor of 1ms guards leaseMs < 3
  // (only reachable in pathological test setups) from producing a zero/negative interval.
  const heartbeatMs = opts.heartbeatMs ?? Math.max(1, Math.floor(queue.leaseMs / 3));
  // Distinguishes "aborted because the lease was reclaimed out from under us" from "aborted
  // because cancel_requested was set" — both go through the same AbortController, but the catch
  // block below needs to know which one happened to pick the right outcome.
  let leaseLost = false;
  const beat = setInterval(() => {
    if (queue.isCancelRequested(job.id)) {
      controller.abort(new DOMException("job cancelled", "AbortError"));
      return; // no further heartbeats needed once aborted
    }
    if (!queue.heartbeat(job.id, leaseOwner)) {
      // heartbeat() returned false: some other worker's claim() already reclaimed this row (its
      // lease_expires_at had passed). Continuing to run the handler races a second execution of
      // the same job with neither worker aware of the other — abort now, with a distinct reason,
      // so the handler stops at its next signal check exactly as it would on cancellation.
      leaseLost = true;
      controller.abort(new DOMException("job lease lost", "AbortError"));
    }
  }, heartbeatMs);
  (beat as unknown as { unref?: () => void }).unref?.();
  try {
    await handler(job, {
      signal: controller.signal,
      checkpoint: (data) => queue.checkpoint(job.id, leaseOwner, data),
    });
    // The handler resolved, but that alone does not mean the completion was PERSISTED —
    // complete() returns false if the lease moved between the last heartbeat and this write.
    // Report what the row actually says, not what the handler's return implies.
    const completed = queue.complete(job.id, leaseOwner);
    return completed ? { outcome: "complete" } : { outcome: "lease-lost" };
  } catch (e) {
    if (leaseLost) {
      // We already know we do not own the lease (the heartbeat above told us so) — skip fail(),
      // whose own lease_owner/state guard would just no-op (changes === 0). Whatever worker
      // reclaimed the row owns its fate now; ours is honestly reported as lease-lost.
      return { outcome: "lease-lost", error: e };
    }
    const cancelled = controller.signal.aborted;
    const failRecorded = queue.fail(job.id, leaseOwner, e, { terminal: cancelled });
    if (!failRecorded) {
      // Lost the lease between the last heartbeat and this write (e.g. the handler threw for an
      // unrelated reason right as another worker's reclaim landed) — same honesty rule as above.
      return { outcome: "lease-lost", error: e };
    }
    return {
      outcome: cancelled ? "failed" : job.attempt >= job.maxAttempts ? "failed" : "retrying",
      error: e,
    };
  } finally {
    clearInterval(beat);
  }
}
