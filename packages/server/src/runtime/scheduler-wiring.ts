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
import type { EmbeddingProvider } from "../embeddings";
import type { AdvisoryBus } from "../mcp/advisories";
import type { MorgianaEmitter } from "../morgiana/emitter";
import type { GatewayRoles } from "../plane/gateway";
import type { JobQueue } from "../scheduler/job-queue";
import type { makeJobRunner } from "../scheduler/job-runner";
import { Scheduler } from "../scheduler/scheduler";
import { DEFAULT_TRACE_FOLDER } from "../tools/m5";
import { schedulerPersistErrorSink } from "../util/errors";
import { registerAdvisorySweep } from "./advisory-sweep";
import { registerGapSweep } from "./gap-sweep";
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
  runReconcile: (signal: AbortSignal) => Promise<void>;
  /** THE-719: the gap sweep embeds each query it sweeps, so it needs the live provider. Also THE-634:
   *  the advisory sweep's goal/candidate similarity uses the same live provider. */
  embeddingProvider: EmbeddingProvider;
  /** THE-634: publish side of the advisory push extension (mcp/advisories.ts). Present only when
   *  `experiential.proactive.enabled` — see server-runtime.ts's construction site. */
  advisoryBus?: AdvisoryBus;
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
    cacheDir: config.cacheDir,
    maintenance: config.maintenance,
    retention: config.observability.retention,
    // THE-891 item 1: content-axis retention on captured episode args, threaded alongside the
    // existing maintenance/retention blocks.
    experiential: config.experiential,
    sessions: config.sessions,
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
    // THE-717: own cadence, and UNDEFINED when the pass is off so no tick is registered at all —
    // an enqueue loop for a job that can never run is the thing this ticket exists to stop.
    citationIntervalMs:
      config.experiential.citationInfer.enabled &&
      config.experiential.citationInfer.transcriptIndex !== undefined
        ? config.experiential.citationInfer.intervalHours * 3_600_000
        : undefined,
    // THE-644 item 3: the ACT-R decay exponent. Every layer beneath already accepted one —
    // `recomputeActivation(edb, now, { decay })` and `registerActivationRecompute`'s `deps.decay`
    // both existed — and nothing ever supplied it, so the only way to change the constant was the
    // eval harness's `seed-activation.ts --decay`, a script rather than a shipped surface.
    activationDecay: config.experiential.activationDecay,
    // THE-726: `deps.db` — cache.db, open unconditionally since boot (wireStores.ts) — NOT the
    // `citationPreferences`-gated handle `wireJobHandlers` builds for the citation job. The
    // derived-verdict pass needs `workspace_sessions.ended_at` regardless of that unrelated flag.
    cacheDb: deps.db,
    derivedVerdictHold: config.experiential.derivedVerdictHold,
  });

  // #14: job-queue runner tick. Unconditional — makeJobRunner no-ops with zero handlers, so this
  // must not be gated behind `roles` (THE-643: that used to starve the unconditional
  // TASK_CALL_JOB_TYPE handler of any drain).
  scheduler.register({
    name: "job-queue-runner",
    intervalMs: CONTRADICTION_DRAIN_MS,
    run: (signal) => deps.jobRunner.drainOnce(signal),
  });

  // THE-719: the coverage-gap sweep. Registered ONLY when explicitly enabled — each swept query
  // costs an embedding call plus a search, so this must never appear on a deployment that did not
  // ask for it. `detectGaps` was CLI-only before this, which is why gap_reports sat empty.
  if (deps.experientialOpen && config.experiential.gapSweep.enabled) {
    registerGapSweep(scheduler, {
      cacheDb: deps.db,
      experientialDb: deps.experientialDb,
      provider: deps.embeddingProvider,
      vaultIds: deps.vaults.map((v) => v.id),
      intervalMs: config.experiential.gapSweep.intervalHours * 3_600_000,
      maxQueries: config.experiential.gapSweep.maxQueries,
      ...(config.retrieval?.rrfK !== undefined ? { rrfK: config.retrieval.rrfK } : {}),
    });
  }

  // THE-634: the scheduled proactive-advisory sweep. Registered ONLY when explicitly enabled AND
  // the advisory push bus was constructed — mirrors registerGapSweep's conditional exactly, and
  // for the same first reason: each tick's scoring costs an embedding call per vault with at least
  // one open session and one open goal, and no deployment should pay that without asking. The
  // second condition (`deps.advisoryBus`) cannot diverge from the first in practice — server-runtime
  // constructs the bus iff the flag is on — but the job takes `publish` as a required dependency, so
  // this guards the type rather than duplicating the config read.
  if (deps.experientialOpen && config.experiential.proactive.enabled && deps.advisoryBus) {
    registerAdvisorySweep(scheduler, {
      cacheDb: deps.db,
      experientialDb: deps.experientialDb,
      provider: deps.embeddingProvider,
      vaultIds: deps.vaults.map((v) => v.id),
      // THE-719's gapSweep names its own interval field; proactive has none in its config surface
      // (§5 of the verified brief lists exactly enabled/minScore/topK/maxPerSession/
      // dismissalPenalty) — it rides the existing maintenance cadence instead, the same interval
      // note-quality's enqueue loop uses just above.
      intervalMs: maintMs,
      policy: {
        minScore: config.experiential.proactive.minScore,
        topK: config.experiential.proactive.topK,
        maxPerSession: config.experiential.proactive.maxPerSession,
        dismissalPenalty: config.experiential.proactive.dismissalPenalty,
      },
      publish: deps.advisoryBus.publish.bind(deps.advisoryBus),
    });
  }

  // THE-458 item 6: the periodic reconcile. The scheduler's single-flight guard matters more here
  // than for any other job — a reconcile walks the whole vault and can outlast its own interval.
  if (config.maintenance.reconcileIntervalMinutes !== undefined) {
    scheduler.register({
      name: "vault-reconcile",
      intervalMs: config.maintenance.reconcileIntervalMinutes * 60_000,
      run: (signal) => deps.runReconcile(signal),
    });
  }

  return scheduler;
}
