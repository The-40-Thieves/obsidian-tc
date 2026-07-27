// THE-292 — periodic cache.db maintenance. Expiry was lazy-only: idempotency rows and elicit
// tokens are checked at read time but never purged, and the event_log retention config
// (observability.retention.eventLogDays) had no enforcement — cache.db grew without bound. The
// sweep DELETEs expired rows, trims event_log, then runs PRAGMA optimize. It is deliberately
// EXPIRED-ONLY for idempotency rows: reaping a crashed in-flight row here could cross-attach a
// stale completion onto a fresh claim — the dispatch-path reclaim (idempotencyReclaimSeconds,
// THE-293) owns that concern. No automatic VACUUM (disruptive under WAL).
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Scheduler } from "../scheduler/scheduler";
import { tableExists } from "./introspect";
import type { Database } from "./types";

export interface SweepCounts {
  idempotency_keys: number;
  elicit_tokens: number;
  event_log: number;
  /** THE-571: terminal `jobs` rows pruned (complete + failed). */
  jobs: number;
  /** THE-610 arm 2: dead agent_episodes pruned from experiential.db (tombstoned or expired only). */
  episodes: number;
  /** THE-610 arm 2: chunk_retrievals rows pruned. Feeds the chunk_access_stats VIEW — see
   *  sweepExperiential's note before changing the retention default. */
  chunk_retrievals: number;
  /** THE-610: session trace files pruned. The sweep's first FILESYSTEM arm — every other count
   *  here is rows in cache.db. */
  trace_files: number;
}

/** A vault's absolute session-trace directory. Resolved by the caller because `traceFolder` is
 *  vault-relative config and this module has no business reading the vault registry. */
export interface TraceDir {
  vaultId: string;
  dir: string;
}

/**
 * THE-610: prune session trace JSONL by AGE. The sweep's only filesystem arm.
 *
 * Age, not reachability. A trace whose session id has no `workspace_sessions` row is the COMMON
 * case, not an anomaly: THE-572 deliberately writes the trace file before the session row so a
 * failed attempt leaves a self-contained orphan rather than a duplicate. Reconciling against the
 * table would therefore delete nothing extra while adding a cross-store join, and would still miss
 * files from a vault whose db was reset. Age covers both.
 *
 * Deliberately narrow about what it will delete:
 *   - only `*.jsonl` directly inside the configured folder, never a recursive walk;
 *   - a missing/unreadable directory is a no-op, not an error — a vault that has never started a
 *     session has no folder, which is normal;
 *   - a per-file failure (permissions, a race with a concurrent write) skips that file and keeps
 *     going, so one bad entry cannot stop the pass.
 *
 * `dryRun` counts what WOULD be deleted without unlinking. This is a delete pass over files inside
 * a user's vault; being able to see the number first is the point.
 */
export function sweepTraceFiles(
  dirs: readonly TraceDir[],
  opts: { now: number; tracesDays: number; dryRun?: boolean },
): number {
  const cutoff = opts.now - opts.tracesDays * 86_400_000;
  let pruned = 0;
  for (const { dir } of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // no folder yet, or unreadable -> nothing to prune here
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(dir, name);
      try {
        if (statSync(file).mtimeMs >= cutoff) continue;
        if (!opts.dryRun) rmSync(file, { force: true });
        pruned += 1;
      } catch {
        /* vanished or unreadable between readdir and unlink -> skip, keep sweeping */
      }
    }
  }
  return pruned;
}

/**
 * THE-571: prune TERMINAL rows from the durable queue. Two things make this safe, and neither is
 * incidental:
 *
 * 1. **Terminal-only.** `queued` / `running` / `retrying` are live work. A `running` row is exactly
 *    how crash recovery finds a job whose lease expired, and a `retrying` row may simply carry a
 *    long backoff — so age says nothing about either, and deleting one loses the job outright.
 * 2. **Retention must outlive the longest dedup period.** enqueue() dedups against a terminal row
 *    unless `replaceIfTerminal` is set; that is how "a completed weekly synthesis blocks re-runs"
 *    works. Deleting that row frees its UNIQUE idempotency_key and lets the period run again. The
 *    defaults (days) sit far above the longest period in use (weekly), but shrinking
 *    `jobsCompleteDays` below a producer's dedup window would silently re-enable duplicate runs.
 *
 * `failed` rows are kept longer than `complete` ones: they are the dead-letter record and exist to
 * be read. The bound is by AGE, matching event_log's existing retention idiom — so a burst of
 * failures inside the window is still unbounded in COUNT. Accepted for now (a storm is a louder
 * problem than its rows), and stated rather than implied.
 *
 * Returns 0 without touching anything when the table is absent (a cache.db predating 20260723_002),
 * so an older db still gets the rest of the sweep instead of the pass dying here.
 */
function sweepJobs(
  db: Database,
  opts: { now: number; completeDays: number; failedDays: number },
): number {
  if (!tableExists(db, "jobs")) return 0;
  const del = db.prepare("DELETE FROM jobs WHERE state = ? AND updated_at < ?");
  const complete = del.run("complete", opts.now - opts.completeDays * 86_400_000).changes;
  const failed = del.run("failed", opts.now - opts.failedDays * 86_400_000).changes;
  return complete + failed;
}

/**
 * THE-610 arm 2 — the EXPERIENTIAL store's two growth curves. Runs against `experiential.db`, a
 * different handle from every other arm here, which is why it takes its own `edb`.
 *
 * ## agent_episodes — DEAD rows only
 *
 * Deletes only rows that are already invisible to every reader: `blocked = 1` (a `forget`
 * tombstone) or `valid_until <= now` (bi-temporally expired). Three read paths filter on exactly
 * this — `reflect.ts`, `knowledge-tools.ts`, `experiential-tools.ts` all carry
 * `(valid_until IS NULL OR valid_until > ?)` — so nothing observable changes when they go.
 *
 * A LIVE episode is never touched, however old. That is the same terminal-only discipline THE-571
 * established for `jobs`, and for the same reason: age is not evidence a row is finished with. The
 * retention window is measured from `valid_until`/`ts`, so a tombstone is kept long enough to still
 * answer "was this forgotten?" before it goes.
 *
 * ## chunk_retrievals — READ THIS BEFORE CHANGING THE DEFAULT
 *
 * This one is NOT pure hygiene, and that is why it defaults to a year rather than to the 30-90 day
 * windows the cache.db arms use. `chunk_access_stats` is a VIEW over this table:
 *
 *   SELECT chunk_id, COUNT(*) AS access_count, MAX(retrieved_at) AS last_accessed_at,
 *          SUM(cited_in_response) AS citations, SUM(outcome) AS outcome_balance
 *   FROM chunk_retrievals GROUP BY chunk_id
 *
 * so deleting rows REWRITES those numbers, and they feed activation and note quality. Pruning
 * aggressively would make a long-tail note that was genuinely useful two years ago look
 * never-accessed, which is a retrieval-behaviour change wearing a disk-hygiene costume — the kind
 * of thing this repo's eval discipline exists to stop shipping unmeasured.
 *
 * The bound still has to exist (the table grows one row per retrieved chunk per query, forever),
 * but a year keeps every signal any current consumer looks at while capping the curve.
 */
export function sweepExperiential(
  edb: Database,
  opts: { now: number; episodesDays: number; retrievalsDays: number },
): { episodes: number; chunk_retrievals: number } {
  let episodes = 0;
  if (tableExists(edb, "agent_episodes")) {
    const cutoff = opts.now - opts.episodesDays * 86_400_000;
    episodes = edb
      .prepare(
        // COALESCE so a tombstone with no explicit valid_until still ages out on its capture time,
        // rather than being immortal because one column is NULL.
        `DELETE FROM agent_episodes
          WHERE (blocked = 1 OR (valid_until IS NOT NULL AND valid_until <= ?))
            AND COALESCE(valid_until, ts) < ?`,
      )
      .run(opts.now, cutoff).changes;
  }
  let retrievals = 0;
  if (tableExists(edb, "chunk_retrievals")) {
    retrievals = edb
      .prepare("DELETE FROM chunk_retrievals WHERE retrieved_at < ?")
      .run(opts.now - opts.retrievalsDays * 86_400_000).changes;
  }
  return { episodes, chunk_retrievals: retrievals };
}

export function runMaintenanceSweep(
  db: Database,
  opts: {
    now: () => number;
    eventLogDays: number;
    jobsCompleteDays: number;
    jobsFailedDays: number;
    /** THE-610. Omitted (or empty) -> the filesystem arm is skipped and `trace_files` is 0. */
    traceDirs?: readonly TraceDir[];
    tracesDays?: number;
    /** THE-610 arm 2: the experiential.db handle. Omitted -> both experiential arms are skipped
     *  and report 0, which is the correct behaviour when the membrane is not open at all. */
    edb?: Database;
    episodesDays?: number;
    retrievalsDays?: number;
    /** THE-610: count what would be pruned without deleting. Applies to the trace arm only —
     *  the row deletes above predate it and are not made conditional here. */
    dryRun?: boolean;
  },
): SweepCounts {
  const t = opts.now();
  const idem = db.prepare("DELETE FROM idempotency_keys WHERE expires_at <= ?").run(t).changes;
  const elicit = db.prepare("DELETE FROM elicit_tokens WHERE expires_at <= ?").run(t).changes;
  const cutoff = t - opts.eventLogDays * 86_400_000;
  const events = db.prepare("DELETE FROM event_log WHERE ts < ?").run(cutoff).changes;
  const jobs = sweepJobs(db, {
    now: t,
    completeDays: opts.jobsCompleteDays,
    failedDays: opts.jobsFailedDays,
  });
  const exp =
    opts.edb !== undefined && opts.episodesDays !== undefined && opts.retrievalsDays !== undefined
      ? sweepExperiential(opts.edb, {
          now: t,
          episodesDays: opts.episodesDays,
          retrievalsDays: opts.retrievalsDays,
        })
      : { episodes: 0, chunk_retrievals: 0 };
  const traceFiles =
    opts.traceDirs && opts.traceDirs.length > 0 && opts.tracesDays !== undefined
      ? sweepTraceFiles(opts.traceDirs, {
          now: t,
          tracesDays: opts.tracesDays,
          ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
        })
      : 0;
  try {
    db.exec("PRAGMA optimize");
  } catch {
    /* optimize is advisory; a failure must not mask the delete counts */
  }
  return {
    idempotency_keys: idem,
    elicit_tokens: elicit,
    event_log: events,
    jobs,
    episodes: exp.episodes,
    chunk_retrievals: exp.chunk_retrievals,
    trace_files: traceFiles,
  };
}

export interface MaintenanceDeps {
  db: Database;
  intervalMs: number;
  eventLogDays: number;
  /** THE-571: retention for terminal `jobs` rows. Must exceed the longest producer dedup window. */
  jobsCompleteDays: number;
  jobsFailedDays: number;
  /** THE-610: per-vault absolute trace directories, resolved by the composition root. */
  traceDirs?: readonly TraceDir[];
  tracesDays?: number;
  /** THE-610 arm 2: experiential.db handle + its two retention windows. Absent -> both arms skip. */
  edb?: Database;
  episodesDays?: number;
  retrievalsDays?: number;
  now?: () => number;
  onSweep?: (counts: SweepCounts) => void;
  onError?: (e: unknown) => void;
}

/** THE-462: register the sweep as a job on a SHARED scheduler (the production path — one timer for
 *  all background work). The run body and error routing are unchanged from the pre-THE-462 standalone
 *  timer; the scheduler owns the (unref'd) timer, single-flight, and — when constructed with a db —
 *  durable scheduling. */
export function registerMaintenanceSweep(scheduler: Scheduler, deps: MaintenanceDeps): void {
  scheduler.register({
    name: "maintenance-sweep",
    intervalMs: deps.intervalMs,
    run: () => {
      const counts = runMaintenanceSweep(deps.db, {
        now: deps.now ?? Date.now,
        eventLogDays: deps.eventLogDays,
        jobsCompleteDays: deps.jobsCompleteDays,
        jobsFailedDays: deps.jobsFailedDays,
        ...(deps.traceDirs !== undefined ? { traceDirs: deps.traceDirs } : {}),
        ...(deps.tracesDays !== undefined ? { tracesDays: deps.tracesDays } : {}),
        ...(deps.edb !== undefined ? { edb: deps.edb } : {}),
        ...(deps.episodesDays !== undefined ? { episodesDays: deps.episodesDays } : {}),
        ...(deps.retrievalsDays !== undefined ? { retrievalsDays: deps.retrievalsDays } : {}),
      });
      deps.onSweep?.(counts);
    },
    onError: (e) => deps.onError?.(e),
  });
}
