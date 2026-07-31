// WP5.2 (issue 16): run_serve's Scheduler construction + every periodic-job registration, extracted
// verbatim out of cli.ts. This file is the single place `scheduler.register(...)` is called from —
// registration ORDER matters (config.scheduler.eventLoopDeferMs's budget deferral cuts off whichever
// jobs are due but not yet run when a tick's time budget is exhausted, so which job registers first
// decides which one is favored), so `wireScheduler` calls out to plane-wiring.ts's domain-specific
// registrations at exactly the point the original inline code did rather than grouping "all plane
// jobs" together for tidiness. Not started here — scheduler.start() is a `ServerRuntime.start()`
// activation step (server-runtime.ts), not construction.
import type { ServerConfig, VaultConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { Database } from "../db/types";
import type { MorgianaEmitter } from "../morgiana/emitter";
import type { GatewayRoles } from "../plane/gateway";
import type { JobQueue } from "../scheduler/job-queue";
import type { makeJobRunner } from "../scheduler/job-runner";
import { Scheduler } from "../scheduler/scheduler";
import { DEFAULT_TRACE_FOLDER } from "../tools/m5";
import { schedulerPersistErrorSink } from "../util/errors";
import { configureMaintenance } from "./maintenance-wiring";
import type { Observability } from "./observability";
import {
  CONTRADICTION_DRAIN_MS,
  registerNoteQualitySchedule,
  registerPlaneSchedule,
} from "./plane-wiring";

export interface SchedulerWiringDeps {
  config: ServerConfig;
  db: Database;
  /** config.vaults — trace dirs are per-vault (maintenance sweep). */
  vaults: VaultConfig[];
  /** run_serve's first vault id — the process-wide sweep event is attributed to it. */
  eventVaultId: string;
  experientialOpen: boolean;
  experientialDb: Database;
  observability: Observability;
  morgiana: MorgianaEmitter;
  roles: GatewayRoles | null;
  jobQueue: JobQueue;
  jobRunner: ReturnType<typeof makeJobRunner>;
  runReconcile: () => Promise<void>;
}

/**
 * THE-462: ONE unref'd background scheduler folds the four formerly-independent setInterval
 * timers into a single tick loop, with shared single-flight, durable last-success/next-run, and
 * budget deferral reachable from config (OFF unless an operator sets it). Registers, in order:
 * maintenance sweep, plane-enqueue (conditional), activation-recompute + note-quality-enqueue
 * (conditional), the unconditional job-queue-runner tick, and vault-reconcile (conditional). Does
 * NOT start the scheduler — see this file's header comment.
 */
export function wireScheduler(deps: SchedulerWiringDeps): Scheduler {
  const { config } = deps;
  const scheduler = new Scheduler({
    now: Date.now,
    db: deps.db,
    // THE-458 item 6: budget deferral was built, tested, and unreachable — this line is the whole
    // fix. Absent by default, so cadence is unchanged; the monitor is not even created when unset.
    ...(config.scheduler.eventLoopDeferMs !== undefined
      ? { eventLoopDeferMs: config.scheduler.eventLoopDeferMs }
      : {}),
    onPersistError: schedulerPersistErrorSink, // THE-666: was silently swallowed; throttled per op+job
  });

  // THE-292: periodic cache.db maintenance.
  configureMaintenance(scheduler, {
    db: deps.db,
    maintenance: config.maintenance,
    retention: config.observability.retention,
    vaults: deps.vaults,
    defaultTraceFolder: DEFAULT_TRACE_FOLDER,
    // THE-610 arm 2: only when the membrane is actually open.
    ...(deps.experientialOpen ? { edb: deps.experientialDb } : {}),
    morgiana: deps.morgiana,
    eventVaultId: deps.eventVaultId,
  });

  registerPlaneSchedule(scheduler, {
    plane: config.plane,
    roles: deps.roles,
    jobQueue: deps.jobQueue,
  });

  const maintMs = config.maintenance.intervalMinutes * 60_000;
  registerNoteQualitySchedule(scheduler, {
    experientialOpen: deps.experientialOpen,
    experientialDb: deps.experientialDb,
    intervalMs: maintMs,
    observability: deps.observability,
    jobQueue: deps.jobQueue,
  });

  // #14: job-queue runner tick. Unconditional — makeJobRunner no-ops with zero handlers, so this
  // must not be gated behind `roles` (THE-643: that used to starve the unconditional
  // TASK_CALL_JOB_TYPE handler of any drain).
  scheduler.register({
    name: "job-queue-runner",
    intervalMs: CONTRADICTION_DRAIN_MS,
    run: (signal) => deps.jobRunner.drainOnce(signal),
  });

  // THE-458 item 6: the periodic reconcile. The scheduler's single-flight guard matters more here
  // than for any other job — a reconcile walks the whole vault and can outlast its own interval.
  if (config.maintenance.reconcileIntervalMinutes !== undefined) {
    scheduler.register({
      name: "vault-reconcile",
      intervalMs: config.maintenance.reconcileIntervalMinutes * 60_000,
      run: () => deps.runReconcile(),
    });
  }

  return scheduler;
}
