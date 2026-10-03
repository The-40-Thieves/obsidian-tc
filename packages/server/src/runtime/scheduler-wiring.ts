// WP5.2 (issue 16): run_serve's Scheduler construction + every periodic-job registration, extracted
// verbatim out of cli.ts. This file is the single place `scheduler.register(...)` is called from —
// registration ORDER matters (config.scheduler.eventLoopDeferMs's budget deferral cuts off whichever
// jobs are due but not yet run when a tick's time budget is exhausted, so which job registers first
// decides which one is favored), so `wireScheduler` calls out to plane-wiring.ts's domain-specific
// registrations at exactly the point the original inline code did rather than grouping "all plane
// jobs" together for tidiness. Not started here — scheduler.start() is a `ServerRuntime.start()`
// activation step (server-runtime.ts), not construction.
import type { ServerConfig, VaultMemoryDefenseConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { FolderAcl } from "../acl";
import type { AuthRegistry } from "../auth/registry";
import type { Database } from "../db/types";
import type { EmbeddingProvider } from "../embeddings";
import type { AdvisoryBus } from "../mcp/advisories";
import type { MorgianaEmitter } from "../morgiana/emitter";
import { compileEgressFilter } from "../plane/egress-filter";
import type { GatewayRoles } from "../plane/gateway";
import type { ProvenanceRecorder } from "../provenance/recorder";
import type { JobQueue } from "../scheduler/job-queue";
import type { makeJobRunner } from "../scheduler/job-runner";
import { Scheduler } from "../scheduler/scheduler";
import { NO_EXCLUSION, type VaultExclusion } from "../search/index-exclusion";
import type { TelemetryWiring } from "../telemetry/wiring";
import { DEFAULT_TRACE_FOLDER } from "../tools/m5";
import { getOrCreateWikiSealKey, readWikiSealKey } from "../tools/m7/knowledge/wiki-generated-seal";
import { schedulerPersistErrorSink } from "../util/errors";
import type { ActiveSessionTracker } from "../workspace/sessions";
import { registerAdvisorySweep } from "./advisory-sweep";
import { registerGapSweep } from "./gap-sweep";
import { configureMaintenance } from "./maintenance-wiring";
import type { Observability } from "./observability";
import {
  CONTRADICTION_DRAIN_MS,
  registerNoteQualitySchedule,
  registerPlaneSchedule,
} from "./plane-wiring";
import { registerWikiLintSweep, wikiLintSweepJudge } from "./wiki-lint-sweep";
import { registerWikiPagesSweep } from "./wiki-pages-sweep";

export interface SchedulerWiringDeps {
  config: ServerConfig;
  db: Database;
  /** The CANONICAL vault roots (server-runtime.ts's call site maps each vault's `root` through
   *  vaultRegistry.resolve(v.id).root, THE-1081 review round 2), not raw config.vaults — trace
   *  dirs are per-vault (maintenance sweep) and this flows straight into
   *  resolveVaultPathChecked, which now refuses a raw config path whose root is itself a
   *  symlink. Narrowed to what configureMaintenance needs (id/root/workspace), field named
   *  `root` rather than `path` so this cannot silently go back to `VaultConfig[]` — see
   *  workspace/sessions.ts's resolveTraceDirs for why that distinction is load-bearing. */
  vaults: readonly {
    id: string;
    root: string;
    workspace?: { traceFolder: string };
    wikiFolder?: string | undefined;
    rawFolders?: readonly string[] | undefined;
  }[];
  /** run_serve's first vault id — the process-wide sweep event is attributed to it. */
  eventVaultId: string;
  /** The live vault registry's ids, read at each memory orphan sweep (add_vault can grow it after
   *  boot). Absent -> the sweep's removed-vault class never runs. */
  listVaultIds?: () => readonly string[];
  /** The auth registry wireTransports opened, when it opened one (see maintenance-wiring.ts). */
  authRegistry?: AuthRegistry;
  /** The write-provenance recorder (absent when disabled): the retention arm re-signs a pruned
   *  chain's head with its live signer. */
  provenance?: ProvenanceRecorder;
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
  /** The vault's Excluded-files filter, for the scheduled wiki lint. Absent -> nothing is excluded. */
  exclusionFor?: (vaultId: string) => VaultExclusion;
  /** The vault's ACL for the scheduled wiki-page regeneration (the registry's per-vault resolver). */
  aclFor?: (vaultId: string) => FolderAcl | undefined;
  /** The vault's memoryDefense policy, applied to what that regeneration writes. */
  memoryDefenseFor?: (vaultId: string) => VaultMemoryDefenseConfig | undefined;
  /** THE-634: publish side of the advisory push extension (mcp/advisories.ts). Present only when
   *  `experiential.proactive.enabled` — see server-runtime.ts's construction site. */
  advisoryBus?: AdvisoryBus;
  /** THE-1125: opt-in telemetry's own registration — `telemetry.registerJob` no-ops when
   *  `config.telemetry.enabled` is false, matching every other conditional job below. Optional so
   *  a caller predating THE-1125 (a direct unit test of wireScheduler) keeps compiling. */
  telemetry?: TelemetryWiring;
  /** THE-1108 fix: the composition root's live tracker — the maintenance sweep's explicit-session
   *  close callback clears its entry here, since SQL closing the row is invisible to this
   *  process-local map otherwise. */
  activeSessions: ActiveSessionTracker;
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
    ...(deps.listVaultIds !== undefined ? { listVaultIds: deps.listVaultIds } : {}),
    memoryOrphanSqlHooks: deps.observability.sqlHooksFor("scheduler"),
    metrics: deps.observability.metrics,
    ...(deps.authRegistry !== undefined ? { authRegistry: deps.authRegistry } : {}),
    // Absent retentionDays (the default) keeps the audit trail forever: the arm is not armed.
    ...(deps.provenance !== undefined && config.provenance.retentionDays !== undefined
      ? {
          provenanceRetention: {
            days: config.provenance.retentionDays,
            signer: () => deps.provenance?.currentSigner(),
            hooks: deps.observability.sqlHooksFor("provenance"),
          },
        }
      : {}),
    // THE-1108 fix: clear the LIVE tracker entry for a session the sweep just closed by SQL — the
    // tracker (server-runtime.ts's stdio context factory reads it) has no other way to learn that.
    onExplicitSessionClosed: (row) => deps.activeSessions.clear(row.principal, row.id),
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
      ...(config.retrieval?.derivedDefaults ? { derivedDefaults: true } : {}),
    });
  }

  // The scheduled wiki lint (lint_wiki's checks on a timer). Registered ONLY when explicitly
  // enabled, and it also needs the maintenance sweep on, like every job on this cadence.
  // Read-only: it logs a summary per vault and writes nothing.
  if (config.maintenance.enabled && config.maintenance.wikiLint.enabled) {
    registerWikiLintSweep(scheduler, {
      cacheDb: deps.db,
      ...(deps.experientialOpen ? { experientialDb: deps.experientialDb } : {}),
      vaults: deps.vaults,
      exclusionFor: deps.exclusionFor ?? (() => NO_EXCLUSION),
      embeddingModel: deps.embeddingProvider.id,
      intervalMs: config.maintenance.wikiLint.intervalHours * 3_600_000,
      folder: config.maintenance.wikiLint.folder,
      maxNotes: config.maintenance.wikiLint.maxNotes,
      judge: wikiLintSweepJudge(config, deps.roles),
      sealKey: () => readWikiSealKey(config.cacheDir),
    });
  }

  // The scheduled regeneration of each wiki folder's generated index.md / log.md. Registered ONLY
  // when explicitly enabled (it writes into the vault unasked), and it also needs the maintenance
  // sweep on. Vaults without a wiki folder are skipped inside the job.
  if (config.maintenance.enabled && config.maintenance.wikiPages.enabled) {
    registerWikiPagesSweep(scheduler, {
      cacheDb: deps.db,
      vaults: deps.vaults,
      aclFor: deps.aclFor ?? (() => undefined),
      exclusionFor: deps.exclusionFor ?? (() => NO_EXCLUSION),
      memoryDefenseFor: deps.memoryDefenseFor,
      snapshots: { enabled: config.snapshots.enabled, retention: config.snapshots.retention },
      intervalMs: config.maintenance.wikiPages.intervalHours * 3_600_000,
      sealKey: () => getOrCreateWikiSealKey(config.cacheDir),
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
      // THE-934 fix round 1 (I3): dropped BEFORE it can become embed input, on top of the
      // embedding PORT guard deps.embeddingProvider already carries.
      excludeFilter: compileEgressFilter(config.egress.excludePaths),
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
  // `deps.runReconcile` is `createReconcileRunner`'s return value (runtime/plane-wiring.ts) — the
  // SAME function boot and promotion catch-up call, so `config.indexing.backgroundEmbed` paces
  // this periodic pass's embed sub-batches identically to boot/promotion. Deliberate: a scheduled
  // repair pass is background work too, and the config key is named `backgroundEmbed` (not
  // `bootEmbed`) for exactly this reason — see plane-wiring.ts's ReconcileRunnerDeps.backgroundEmbed.
  if (config.maintenance.reconcileIntervalMinutes !== undefined) {
    scheduler.register({
      name: "vault-reconcile",
      intervalMs: config.maintenance.reconcileIntervalMinutes * 60_000,
      run: (signal) => deps.runReconcile(signal),
    });
  }

  // THE-1125: opt-in telemetry send. Registered LAST, after every job an operator actually cares
  // about the latency of — telemetry is the lowest-priority background work in this process, and
  // registration order only matters under `config.scheduler.eventLoopDeferMs` budget deferral
  // (this file's own header comment), where earlier-registered jobs win a contested tick.
  // `registerJob` itself is the enabled/endpoint gate; see telemetry/wiring.ts.
  deps.telemetry?.registerJob(scheduler);

  return scheduler;
}
