// run_serve's job-queue / job-handler / reconcile-runner / plane-schedule wiring.
//
// Composition order is load-bearing (do not reorder without checking server-runtime.ts):
//   * createJobQueue runs before tool-wiring.ts's health tool registers — server_health's
//     getJobQueueStats accessor closes over this SAME jobQueue instance.
//   * createOnIndexedHook is a factory, not a single closure: indexing-wiring.ts's
//     wireIndexCoordinator, M1's indexVault, and this file's createReconcileRunner all share the
//     SAME `(vaultId) => IndexHook | undefined` shape, bound to one jobQueue/roles pair.
//
// See docs/design/runtime-job-wiring.md for the extraction/durability history behind this shape.
import type { ServerConfig, VaultConfigInput } from "@the-40-thieves/obsidian-tc-shared";
import type { FolderAcl } from "../acl";
import type { WriteTxnHooks } from "../db/txn";
import type { Database } from "../db/types";
import type { EmbeddingProvider } from "../embeddings";
import { runCitationIndexPasses } from "../experiential/citation-index";
import { deriveClosedWindows } from "../experiential/derive-verdict";
import { expireOverdueGoals } from "../experiential/goals";
import { recomputeNoteQualityAll } from "../experiential/note-quality";
import { registerEpisodeEvaluation } from "../experiential/reflect";
import type { ToolRegistry } from "../mcp/registry";
import { TASK_CALL_JOB_TYPE } from "../mcp/tasks";
import type { GatewayRoles } from "../plane/gateway";
import { auditJob } from "../plane/jobs/audit";
import { checkContradictions, loadChunkForContradiction } from "../plane/jobs/contradiction";
import { isoWeek, runSynthesis } from "../plane/jobs/synthesis";
import { wrapPlaneJob } from "../plane/plane";
import { JobQueue } from "../scheduler/job-queue";
import { type JobHandler, makeJobRunner } from "../scheduler/job-runner";
import type { Scheduler } from "../scheduler/scheduler";
import { makeTaskCallHandler } from "../scheduler/task-call-runner";
import type { IndexHook, IndexStats, IndexVaultArgs } from "../search/indexer";
import type { RepresentationManifest } from "../search/representation";
import type { VecRebuildEvent } from "../search/vec";
import { errorMessage, stderrOnError } from "../util/errors";
import { contentHash } from "../vault/paths";
import type { VaultRegistry } from "../vault/registry";
import type { IndexHealthState } from "./indexing-wiring";
import { type Observability, wireActivationRecompute } from "./observability";
import { applyReconcileOutcome } from "./reconcile-outcome";
import { planeRoles } from "./tool-wiring";

// Content-derived key, deliberately: a completed/dead-lettered job for a given key must not
// permanently block re-judging recurring identical content — see EnqueueOptions.replaceIfTerminal.
const CONTRADICTION_MAX_ATTEMPTS = 3;
/** Interval for the unconditional job-queue-runner scheduler tick (scheduler-wiring.ts). */
export const CONTRADICTION_DRAIN_MS = 15_000;

/** The job queue claims across every vault from one process-wide connection, so it has no vault id
 *  to report; "scheduler" is the bounded subsystem name (THE-585, #5). Hoisted ahead of
 *  tool-wiring.ts's health-tool registration so its stats accessor can close over it. */
export function createJobQueue(
  db: Database,
  sqlHooksFor: (vault: string) => WriteTxnHooks,
): JobQueue {
  return new JobQueue(db, { now: Date.now, sql: sqlHooksFor("scheduler") });
}

/** The one gate every plane-scoped (contradiction/synthesis/audit) consumer of `roles` in this file
 *  must route through, rather than reading `deps.roles` alone (THE-822, #788 — see
 *  docs/design/runtime-job-wiring.md). `plane` is a REQUIRED dep, not optional, so no call site can
 *  forget to state the plane's status. Module-private: `wireDomainTools` (tool-wiring.ts) must keep
 *  the full, ungated `roles` for `reflect` and friends, which stay live with the plane off — it must
 *  NOT call this helper. */
function planeGatedRoles(deps: {
  plane: { enabled: boolean };
  roles: GatewayRoles | null;
}): GatewayRoles | null {
  return deps.plane.enabled ? deps.roles : null;
}

/**
 * W-INGEST onIndexed hook -> contradiction-check enqueue. The detector needs the gateway, so the
 * returned hook is a no-op factory (`undefined`) when `roles` is absent. Content-sensitive key:
 * chunk.id is deterministic from PATH+POSITION, not content, and enqueue() dedups against a
 * completed job's row forever (jobs are never pruned) — folding in the content hash makes an edit
 * (new content) a distinct key, re-judged, while an identical-content rapid re-index still dedups.
 *
 * Also gated on `plane.enabled` via planeGatedRoles — `plane.enabled: false` must stop this
 * per-index-write enqueue, not just the scheduled consolidation pass (THE-822, #788).
 */
export function createOnIndexedHook(deps: {
  jobQueue: JobQueue;
  roles: GatewayRoles | null;
  plane: { enabled: boolean };
}): (vaultId: string) => IndexHook | undefined {
  return (vaultId: string): IndexHook | undefined =>
    planeGatedRoles(deps)
      ? (chunks) => {
          for (const c of chunks) {
            deps.jobQueue.enqueue("contradiction", {
              class: "contradiction",
              payload: { vaultId, chunkId: c.id },
              idempotencyKey: `${vaultId}:${c.id}:${contentHash(c.content)}`,
              maxAttempts: CONTRADICTION_MAX_ATTEMPTS,
              // A completed or dead-lettered job for this exact key must not permanently block
              // re-judging recurring identical content (revert, or re-index after dead-letter).
              replaceIfTerminal: true,
            });
          }
        }
      : undefined;
}

export interface JobHandlersDeps {
  registry: ToolRegistry;
  db: Database;
  acl: FolderAcl;
  jobQueue: JobQueue;
  roles: GatewayRoles | null;
  /** THE-822: gates the contradiction/synthesis/audit handlers below, via planeGatedRoles —
   *  task-call and note-quality are unaffected. Required, not optional: every caller must state
   *  the plane's status rather than a fourth call site being able to forget it. */
  plane: { enabled: boolean };
  embeddingProvider: EmbeddingProvider;
  experientialOpen: boolean;
  experientialDb: Database;
  /** config.plane.maxPromptChars — aggregate cap on a generative job's whole gateway request.
   *  Absent -> each job's own conservative default. */
  maxPromptChars?: number | undefined;
  /** config.plane.gatewayMaxAttempts — retry budget for the PLANE's gateway calls, separate from
   *  the interactive seam. Absent -> the interactive client's own default. */
  gatewayMaxAttempts?: number | undefined;
  /** config.plane.gatewayTimeoutMs — PER-ATTEMPT budget for the PLANE's gateway calls (THE-709).
   *  Distinct from gatewayMaxAttempts: attempts rescue a transient failure, this rescues a slow
   *  one. Absent -> the interactive client's own 60s default. */
  gatewayTimeoutMs?: number | undefined;
  /** config.vaults */
  vaults: VaultConfigInput[];
  /** config.experiential.citationInfer — absent or without a transcriptIndex means the handler is
   *  NOT registered. See the registration below for why a path is the real gate. */
  citationInfer?: { enabled: boolean; transcriptIndex?: string | undefined } | undefined;
  /** Query-side embedder for the citation pass's stage-1 cosine leg. */
  embed?: ((texts: string[]) => Promise<number[][]>) | undefined;
  /** Authored cache store — the citation pass reads chunk content and stored vectors from it. */
  cacheDb?: Database | undefined;
}

export interface JobHandlersWiring {
  jobHandlers: Map<string, JobHandler>;
  jobRunner: ReturnType<typeof makeJobRunner>;
}

/** Build the durable job-type handler map (task-call always; contradiction/synthesis/audit only
 *  with plane.enabled AND a gateway, THE-822; note-quality only with the experiential store open)
 *  and the job-queue runner. */
export function wireJobHandlers(deps: JobHandlersDeps): JobHandlersWiring {
  const jobHandlers = new Map<string, JobHandler>();
  jobHandlers.set(
    TASK_CALL_JOB_TYPE,
    makeTaskCallHandler({
      registry: deps.registry,
      db: deps.db,
      acl: deps.acl,
      queue: deps.jobQueue,
    }),
  );
  // THE-822: gated on plane.enabled AND roles, not roles alone — see planeGatedRoles above.
  const gatedRoles = planeGatedRoles(deps);
  if (gatedRoles) {
    const roles = gatedRoles;
    jobHandlers.set("contradiction", async (job) => {
      const { vaultId, chunkId } = job.payload as { vaultId: string; chunkId: string };
      const chunk = loadChunkForContradiction(deps.db, vaultId, chunkId);
      // Deleted or re-embedded between enqueue and run — a normal race, not a failure. Returning
      // marks the job complete; THROWING here would dead-letter a job that did nothing wrong.
      if (!chunk) return;
      const jobCtx = { db: deps.db, roles, now: Date.now, model: deps.embeddingProvider.id };
      const r = await checkContradictions(jobCtx, vaultId, [chunk]);
      // THE-613: an unjudged pair is a FAILURE, not a clean result. Retry is safe (INSERT OR
      // IGNORE on a content-derived id).
      if (r.unjudged > 0) throw new Error(`contradiction: ${r.unjudged}/${r.checked} unjudged`);
    });
    // synthesis/audit are durable jobs; wrapPlaneJob turns their ok:false into the THROW its
    // dead-letter/retry needs.
    //
    // Scheduled jobs get their own longer-budget client (attempts AND per-attempt timeout are
    // separate knobs, rescuing a transient vs. a deterministically-slow failure respectively).
    // Falls back to the interactive roles when unconfigured, so behaviour is unchanged without the
    // knob. History and measurements: CHANGELOG.md THE-700 (#659) and THE-709; see also
    // docs/design/runtime-gateway-seams.md.
    const bgRoles =
      (deps.gatewayMaxAttempts !== undefined
        ? planeRoles(deps.gatewayMaxAttempts, deps.gatewayTimeoutMs)
        : null) ?? roles;
    const planeCtx = {
      db: deps.db,
      roles: bgRoles,
      now: Date.now,
      ...(deps.maxPromptChars !== undefined ? { maxPromptChars: deps.maxPromptChars } : {}),
    };
    const synthesisJob = wrapPlaneJob("synthesis", () => runSynthesis(planeCtx), planeCtx);
    const auditPassJob = wrapPlaneJob("audit", () => auditJob.run(planeCtx), planeCtx);
    jobHandlers.set("synthesis", synthesisJob);
    jobHandlers.set("audit", auditPassJob);
  }
  // No gateway dependency here (THE-643, #813).
  if (deps.experientialOpen) {
    const vaultIds = deps.vaults.map((v) => v.id);
    const noteQualityJob = wrapPlaneJob(
      "note-quality",
      async () => ({
        ok: true,
        detail: {
          per_vault: recomputeNoteQualityAll(deps.db, deps.experientialDb, vaultIds, Date.now()),
        },
      }),
      // No planeCtx here — note-quality has no gateway dependency — but job_runs lives in the same
      // cache db, so the recorder is built from what this branch already has (THE-716).
      { db: deps.db, now: Date.now },
    );
    jobHandlers.set("note-quality", noteQualityJob);
  }
  // Citation job: FOUR conditions gate registration, each ruling out a job that would look
  // scheduled while doing nothing or doing active harm:
  //   experientialOpen  — chunk_retrievals is where it reads and writes
  //   enabled           — opt-in, per the config block
  //   transcriptIndex   — THE REAL GATE. No producer means no input; a handler with no possible
  //                       input is worse than an absent one, reporting success with zero work.
  //   roles (gateway)   — NOT merely "matching the contradiction job". Without a judge the pass
  //                       runs stage-1-only and stamps every survivor cited_in_response = 1 with
  //                       state `candidate`, which COUNTS toward note_quality's 0.6-weighted
  //                       citation rate — an unattended stage-1-only schedule would inflate 60% of
  //                       every score with rows no judge ever read. A human can still choose that
  //                       mode at the CLI, deliberately.
  // History (THE-717, #708/#709/#707) and the 105-of-105-NULL measurement:
  // docs/design/runtime-job-wiring.md.
  const citationIndexPath = deps.citationInfer?.transcriptIndex;
  if (
    deps.experientialOpen &&
    deps.citationInfer?.enabled === true &&
    citationIndexPath !== undefined &&
    deps.roles &&
    deps.cacheDb &&
    deps.embed
  ) {
    const roles = deps.roles;
    const cacheDb = deps.cacheDb;
    const embed = deps.embed;
    const citationJob = wrapPlaneJob(
      "citation",
      async () => ({
        ok: true,
        detail: await runCitationIndexPasses(citationIndexPath, deps.experientialDb, cacheDb, {
          embed,
          judge: (r) => roles.judge(r).then((x) => ({ text: x.text, model: x.model })),
        }),
      }),
      { db: deps.db, now: Date.now },
    );
    jobHandlers.set("citation", citationJob);
  }
  const jobRunner = makeJobRunner({
    queue: deps.jobQueue,
    leaseOwner: `serve:${process.pid}`,
    handlers: jobHandlers,
    classLimits: { contradiction: 4, plane: 1 },
    // outcomes are surfaced via server_health stats, not per-job logging; onOutcome left unset
  });
  return { jobHandlers, jobRunner };
}

export interface ReconcileRunnerDeps {
  /** config.vaults */
  vaults: VaultConfigInput[];
  db: Database;
  embeddingProvider: EmbeddingProvider;
  embedConfig: { batchSize: number; concurrency: number; maxBatchTokens: number };
  /** config.embeddings.chunkContext */
  chunkContext: boolean;
  /** THE-424: config.indexing.chunkTokens. Undefined -> the chunker's 512 default. */
  chunkTokens?: number;
  /** THE-683: the representation identity built ONCE by wireIndexResources and passed through,
   *  never re-derived here. Replaces the loose `revision` field, whose doc had to warn that it
   *  "must match indexing-wiring.ts" — a constraint the type system now enforces instead. */
  representation: RepresentationManifest;
  /** config.retrieval.densify */
  densify: ServerConfig["retrieval"]["densify"];
  vaultRegistry: VaultRegistry;
  indexReadableFor: (vaultId: string) => (rel: string) => boolean;
  sqlHooksFor: (vault: string) => WriteTxnHooks;
  onVecRebuild: (event: VecRebuildEvent) => void;
  makeOnIndexed: (vaultId: string) => IndexHook | undefined;
  indexHealth: IndexHealthState;
  /** config.indexing.streamingWalk */
  streamingWalk: boolean;
  indexVaultRecorded: (opts: IndexVaultArgs) => Promise<IndexStats>;
  roles: GatewayRoles | null;
  jobRunner: ReturnType<typeof makeJobRunner>;
}

/**
 * Re-sync the search index with every vault (THE-255): incremental (content-hash skip) and
 * best-effort — an embedding-backend or fs hiccup degrades the index, never startup. THE-458 item
 * 6: extracted so the SAME pass can run both at boot (fire-and-forget) and on the scheduler.
 */
export function createReconcileRunner(
  deps: ReconcileRunnerDeps,
): (signal: AbortSignal) => Promise<void> {
  return async (signal: AbortSignal): Promise<void> => {
    // THE-926: cooperate with graceful shutdown. The per-vault passes below still run concurrently
    // (Promise.all, unchanged — reconcile has no cheap intra-vault checkpoint to bail at without
    // threading the signal into indexVaultRecorded's own walk, out of scope here), so this can only
    // stop a reconcile from STARTING once shutdown has begun; a reconcile already in flight when the
    // signal fires still runs to completion, same as before this ticket.
    if (signal.aborted) return;
    await Promise.all(
      deps.vaults.map((v) =>
        deps
          .indexVaultRecorded({
            db: deps.db,
            provider: deps.embeddingProvider,
            embed: deps.embedConfig,
            chunkContext: deps.chunkContext,
            representation: deps.representation,
            densify: deps.densify,
            vaultId: v.id,
            root: deps.vaultRegistry.resolve(v.id).root,
            isReadable: deps.indexReadableFor(v.id),
            now: Date.now,
            sql: deps.sqlHooksFor(v.id),
            onVecRebuild: deps.onVecRebuild,
            onIndexed: deps.makeOnIndexed(v.id),
            // THE-291: metadata/FTS readiness is independent of embed success.
            onNotesPass: () => {
              deps.indexHealth.notesReady = true;
            },
            // THE-490/THE-591: indexing.streamingWalk. Off by default -> byte-identical to before.
            walk: { streaming: deps.streamingWalk },
          })
          .then(
            // THE-390: a completed reconcile that had to SKIP notes still degrades health —
            // precise, non-fatal, retried next reconcile — instead of aborting the whole reindex.
            (s) => ({
              vault: v.id,
              error:
                s.notes_embed_failed > 0
                  ? `${s.notes_embed_failed} note(s) skipped: embed provider rejected their chunks (HTTP 400)`
                  : (null as string | null),
            }),
            (e) => ({ vault: v.id, error: errorMessage(e) }),
          ),
      ),
    ).then(async (results) => {
      applyReconcileOutcome(results, deps.indexHealth, {
        now: Date.now,
        write: (m) => process.stderr.write(m),
      });
      // #14: sweep jobs enqueued during the reconcile through the SAME durable runner as runtime
      // writes, rather than waiting for the scheduler's next CONTRADICTION_DRAIN_MS tick. No-op
      // without the gateway. Fire-and-forget by design; the jobs are durable, so a crash before
      // this runs loses nothing — the next tick or process restart picks them up.
      if (!deps.roles) return;
      // THE-926: the REAL signal, not a fresh never-aborted one — drainOnce already checks
      // `signal.aborted` between claimed jobs (job-runner.ts), so threading this one through lets a
      // shutdown mid-reconcile stop the sweep from claiming further jobs instead of running unbounded.
      await deps.jobRunner.drainOnce(signal);
    });
  };
}

/**
 * THE-296 / #14: ambient sleep-time consolidation (weekly synthesis + daily audit) as durable jobs.
 * Registered only when BOTH `plane.enabled` and gateway roles are present: the generative jobs
 * degrade without roles, but scheduling them then is pure DB churn. Idempotency keys (per iso-week
 * / per-day) keep a slow run from piling up duplicate jobs.
 */
export function registerPlaneSchedule(
  scheduler: Scheduler,
  deps: {
    /** config.plane */
    plane: { enabled: boolean; intervalMinutes: number };
    roles: GatewayRoles | null;
    jobQueue: JobQueue;
  },
): void {
  if (!(deps.plane.enabled && deps.roles)) return;
  scheduler.register({
    name: "plane-enqueue",
    intervalMs: deps.plane.intervalMinutes * 60_000,
    // THE-926: honor a shutdown already in flight rather than enqueueing new durable work into a
    // store that may be about to close.
    run: (signal) => {
      if (signal.aborted) return;
      const iso = isoWeek(new Date());
      // `replaceIfFailed`, NOT `replaceIfTerminal`: these keys name a PERIOD, and
      // `replaceIfTerminal` also replaces `complete`, so it would delete and re-run already
      // SUCCESSFUL work every tick. The narrow flag keeps the guarantee that a failed period is
      // re-enqueueable while still throttling a period key to once-per-period. maxAttempts stays 1:
      // the gateway client owns the retry budget (plane.gatewayMaxAttempts), and a job-level retry
      // of a genuine 4xx would only repeat the same mistake. History and measurements (THE-700
      // #659, THE-723 #687): CHANGELOG.md.
      deps.jobQueue.enqueue("synthesis", {
        class: "plane",
        idempotencyKey: `synthesis:${iso.year}-${iso.week}`,
        maxAttempts: 1,
        replaceIfFailed: true,
      });
      const day = new Date().toISOString().slice(0, 10);
      deps.jobQueue.enqueue("audit", {
        class: "plane",
        idempotencyKey: `audit:${day}`,
        maxAttempts: 1,
        replaceIfFailed: true,
      });
    },
    onError: (e) => process.stderr.write(`[plane-enqueue] enqueue failed: ${errorMessage(e)}\n`),
  });
}

/**
 * THE-227/228: keep cached_activation_score warm as capture accrues, and THE-643's note-quality
 * enqueue — both reuse the maintenance cadence. Registered only while the experiential store is
 * open; idempotent, no gateway, best-effort.
 */
export function registerNoteQualitySchedule(
  scheduler: Scheduler,
  deps: {
    experientialOpen: boolean;
    experientialDb: Database;
    /** config.maintenance.intervalMinutes * 60_000 — computed once by the caller and shared by
     *  both the activation-recompute registration and the note-quality-enqueue tick below. */
    intervalMs: number;
    observability: Pick<Observability, "onActivationRecompute">;
    jobQueue: JobQueue;
    /** config.experiential.citationInfer.intervalHours in ms, or undefined when the pass is off.
     *  Its own cadence rather than the maintenance interval: the pass costs gateway judge calls. */
    citationIntervalMs?: number | undefined;
    /** config.experiential.activationDecay — the ACT-R decay exponent (THE-644 item 3). Threaded
     *  rather than defaulted here: `recomputeActivation` owns the default, and a second copy of it
     *  in the wiring is how two defaults drift apart. */
    activationDecay?: number | undefined;
    /** THE-726: cache.db — ALWAYS the live handle (`SchedulerWiringDeps.db`), NOT the
     *  `citationPreferences`-gated one `wireJobHandlers` builds. `workspace_sessions.ended_at`
     *  must be reachable regardless of that unrelated flag. */
    cacheDb: Database;
    /** config.experiential.derivedVerdictHold. */
    derivedVerdictHold?: boolean;
  },
): void {
  if (!deps.experientialOpen) return;
  wireActivationRecompute(scheduler, deps.observability, {
    edb: deps.experientialDb,
    intervalMs: deps.intervalMs,
    ...(deps.activationDecay !== undefined ? { decay: deps.activationDecay } : {}),
  });
  // The evaluator pass that promotes pending -> eligible (THE-698, #648 — history and the
  // 337-of-337-pending measurement in docs/design/runtime-job-wiring.md).
  //
  // No judge is passed, deliberately, and this is not a degraded mode: the judge can only LOWER a
  // deterministic promotion, never raise one, so the deterministic layer is the whole job. Same
  // no-gateway-dependency posture as note-quality-enqueue below — a derived-state tick must not
  // depend on the generative plane being configured. Wire `judge` here if that changes.
  // THE-726: the derived-verdict pass, run in the SAME tick immediately before evaluateEpisodes
  // (deriveClosedWindows below is called from registerEpisodeEvaluation's own `run`, not here — see
  // that function's own comment for why the closure crosses the module boundary this way).
  // `cacheDb` is `deps.cacheDb` — the ALWAYS-open handle, independent of `citationPreferences` —
  // so this step never depends on that unrelated flag.
  registerEpisodeEvaluation(scheduler, {
    edb: deps.experientialDb,
    intervalMs: deps.intervalMs,
    derivedVerdictHold: deps.derivedVerdictHold,
    deriveClosedWindows: () =>
      deriveClosedWindows(deps.experientialDb, deps.cacheDb, { nowMs: Date.now() }),
    onError: stderrOnError("episode-evaluation"),
  });
  // THE-643: own cadence, not the roles-gated plane-enqueue above — no gateway dependency.
  scheduler.register({
    name: "note-quality-enqueue",
    intervalMs: deps.intervalMs,
    // THE-926: same shutdown-cooperation guard as plane-enqueue above.
    run: (signal) => {
      if (signal.aborted) return;
      deps.jobQueue.enqueue("note-quality", {
        class: "plane",
        idempotencyKey: `note-quality:${new Date().toISOString().slice(0, 10)}`,
        maxAttempts: 1,
      });
    },
    onError: stderrOnError("note-quality-enqueue"),
  });
  // THE-717: enqueue the citation pass. Its own cadence, like gapSweep and note-quality — the
  // enqueue is unconditional here because the HANDLER registration is what gates it: an enqueue
  // with no registered handler dead-letters loudly rather than silently doing nothing, which is
  // the failure mode worth having if the two ever disagree.
  //
  // The idempotency key is the DAY plus the interval bucket, not the day alone: unlike
  // note-quality this can legitimately run several times a day, and a day-only key would silently
  // throttle every pass after the first — the shape THE-296 hit with `synthesis:<iso-week>`.
  if (deps.citationIntervalMs !== undefined) {
    const bucketMs = deps.citationIntervalMs;
    scheduler.register({
      name: "citation-enqueue",
      intervalMs: bucketMs,
      // THE-926: same shutdown-cooperation guard as plane-enqueue above.
      run: (signal) => {
        if (signal.aborted) return;
        deps.jobQueue.enqueue("citation", {
          class: "plane",
          idempotencyKey: `citation:${Math.floor(Date.now() / bucketMs)}`,
          maxAttempts: 1,
        });
      },
      onError: stderrOnError("citation-enqueue"),
    });
  }
  // The goal expiry sweep (THE-633, #675). Registered here, in the same change that adds the
  // table, deliberately — see docs/design/runtime-job-wiring.md for why an unscheduled sweep is a
  // recurring failure shape in this codebase, not a one-off.
  //
  // Direct, not enqueued: this is a single bounded UPDATE over one indexed predicate, with no
  // gateway dependency and nothing to retry. The durable job queue is for work that can fail
  // halfway; this cannot.
  scheduler.register({
    name: "goal-expiry",
    intervalMs: deps.intervalMs,
    // THE-926: same shutdown-cooperation guard as plane-enqueue above.
    run: (signal) => {
      if (signal.aborted) return;
      expireOverdueGoals(deps.experientialDb, Date.now());
    },
    onError: stderrOnError("goal-expiry"),
  });
}
