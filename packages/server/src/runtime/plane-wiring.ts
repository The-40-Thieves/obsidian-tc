// WP5.2 (issue 16): run_serve's job-queue / job-handler / reconcile-runner / plane-schedule wiring,
// extracted verbatim out of cli.ts. Several pieces here are deliberately constructed AHEAD of their
// conceptual home:
//
//   * `createJobQueue` is called before tool-wiring.ts's health tool is registered, because
//     server_health's getJobQueueStats accessor closes over the SAME jobQueue instance — see
//     server-runtime.ts's composition order.
//   * `createOnIndexedHook` is a factory (not a single closure) because indexing-wiring.ts's
//     wireIndexCoordinator, M1's indexVault, and this file's own createReconcileRunner all need the
//     SAME `(vaultId) => IndexHook | undefined` shape, bound to the one jobQueue/roles pair.
//
// #14: durable contradiction/synthesis/audit jobs (was an in-memory queue that dropped under
// backpressure). THE-643: note-quality reuses the maintenance cadence, no gateway dependency.
import type { ServerConfig, VaultConfigInput } from "@the-40-thieves/obsidian-tc-shared";
import type { FolderAcl } from "../acl";
import type { WriteTxnHooks } from "../db/txn";
import type { Database } from "../db/types";
import type { EmbeddingProvider } from "../embeddings";
import { runCitationIndexPasses } from "../experiential/citation-index";
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

// #14 (contradiction handler): a completed/dead-lettered job for a given key must not permanently
// block re-judging recurring identical content — see EnqueueOptions.replaceIfTerminal.
const CONTRADICTION_MAX_ATTEMPTS = 3;
/** Interval for the unconditional job-queue-runner scheduler tick (scheduler-wiring.ts). */
export const CONTRADICTION_DRAIN_MS = 15_000;

/** THE-585 (#5): the job queue claims across every vault from one process-wide connection, so it
 *  has no vault id to report; "scheduler" is the bounded subsystem name. Hoisted ahead of
 *  tool-wiring.ts's health-tool registration so its stats accessor can close over it. */
export function createJobQueue(
  db: Database,
  sqlHooksFor: (vault: string) => WriteTxnHooks,
): JobQueue {
  return new JobQueue(db, { now: Date.now, sql: sqlHooksFor("scheduler") });
}

/**
 * W-INGEST onIndexed hook -> contradiction-check enqueue. The detector needs the gateway, so the
 * returned hook is a no-op factory (`undefined`) when `roles` is absent. Content-sensitive key:
 * chunk.id is deterministic from PATH+POSITION, not content, and enqueue() dedups against a
 * completed job's row forever (jobs are never pruned) — folding in the content hash makes an edit
 * (new content) a distinct key, re-judged, while an identical-content rapid re-index still dedups.
 */
export function createOnIndexedHook(deps: {
  jobQueue: JobQueue;
  roles: GatewayRoles | null;
}): (vaultId: string) => IndexHook | undefined {
  return (vaultId: string): IndexHook | undefined =>
    deps.roles
      ? (chunks) => {
          for (const c of chunks) {
            deps.jobQueue.enqueue("contradiction", {
              class: "contradiction",
              payload: { vaultId, chunkId: c.id },
              idempotencyKey: `${vaultId}:${c.id}:${contentHash(c.content)}`,
              maxAttempts: CONTRADICTION_MAX_ATTEMPTS,
              // #14: a completed or dead-lettered job for this exact key must not permanently
              // block re-judging recurring identical content (revert, or re-index after
              // dead-letter).
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
 *  with a gateway; note-quality only with the experiential store open) and the job-queue runner. */
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
  if (deps.roles) {
    const roles = deps.roles;
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
    // #14: synthesis/audit are durable jobs; wrapPlaneJob turns their ok:false into the THROW its
    // dead-letter/retry needs.
    // THE-700: the SCHEDULED jobs get their own longer-budget client. The Modal endpoints scale
    // to zero and a cold start measured >180s, past the interactive 3x60s. Falls back to the
    // interactive roles when unconfigured, so behaviour is unchanged without the knob.
    //
    // THE-709: attempts alone were NOT enough, and the two knobs cover different failures. Attempts
    // rescue a TRANSIENT failure (cold start, 5xx, dropped connection). A request that is merely
    // SLOW exceeds the per-attempt timeout identically on every attempt — measured at 370.4s twice,
    // 45 minutes apart and 12ms from each other, which is 6 x 60s expiring on schedule rather than
    // a cold start varying. The endpoint answered a small completion in 360ms throughout, so there
    // was nothing to wait out. gatewayTimeoutMs is the knob for that case.
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
  // THE-643: note_quality was write-only (an unused CLI command); no gateway dependency here.
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
  // THE-717: the citation pass finally gets a scheduled caller. It had exactly one — the offline
  // CLI — so every citation column was NULL on 105 of 105 live rows.
  //
  // FOUR conditions, and each rules out a job that would look scheduled while doing nothing:
  //   experientialOpen  — chunk_retrievals is where it reads and writes
  //   enabled           — opt-in, per the config block
  //   transcriptIndex   — THE REAL GATE. Without a producer there is no input, and a handler with
  //                       no possible input is worse than an absent one: it reports success with
  //                       zero work forever, which is the exact shape THE-716/THE-717 kept finding.
  //   roles (gateway)   — NOT merely "matching the contradiction job". Without a judge the pass
  //                       runs stage-1-only and stamps every survivor cited_in_response = 1 with
  //                       state `candidate`. That COUNTS as a citation in chunk_access_stats, and
  //                       note_quality weights citation rate at 0.6 — so an unattended stage-1-only
  //                       schedule would inflate 60% of every quality score with rows no judge ever
  //                       read. A human can still choose that mode at the CLI, deliberately.
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
export function createReconcileRunner(deps: ReconcileRunnerDeps): () => Promise<void> {
  return async (): Promise<void> => {
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
      await deps.jobRunner.drainOnce(new AbortController().signal);
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
    run: () => {
      const iso = isoWeek(new Date());
      // THE-700: a failure must not cost the WHOLE period. enqueue() dedups against a terminal
      // row, so a `failed` synthesis would keep `synthesis:<iso-week>` and every later enqueue
      // that week became a silent no-op — one cold-start timeout locked out the entire week's
      // consolidation until the row was deleted by hand. maxAttempts stays 1: the gateway client
      // owns the retry budget (plane.gatewayMaxAttempts), and a job-level retry of a genuine 4xx
      // would only repeat the same mistake.
      //
      // THE-723: `replaceIfFailed`, NOT `replaceIfTerminal`. These keys name a PERIOD, and
      // `replaceIfTerminal` also replaces `complete` — so the plane deleted and re-ran its own
      // SUCCESSFUL work every tick and the period key throttled nothing. `audit` succeeds every
      // run and still went from 2 writes/day to 243. The narrow flag keeps THE-700's guarantee
      // (a failed period is re-enqueueable) while restoring "once per period" for a period key.
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
  },
): void {
  if (!deps.experientialOpen) return;
  wireActivationRecompute(scheduler, deps.observability, {
    edb: deps.experientialDb,
    intervalMs: deps.intervalMs,
    ...(deps.activationDecay !== undefined ? { decay: deps.activationDecay } : {}),
  });
  // THE-698: the evaluator pass that promotes pending -> eligible. It had NO scheduled caller —
  // only the manual `obsidian-tc reflect` CLI — so on the live deployment 337 of 337 episodes sat
  // `pending` across seventeen days and `work_search`, which serves eligible rows only by contract,
  // returned zero rows every time. The capture half of the experiential tier worked; the recall
  // half was dark, and an honest-empty result is indistinguishable from "nothing matched".
  //
  // No judge is passed, deliberately, and this is not a degraded mode: the judge can only LOWER a
  // deterministic promotion, never raise one, so the deterministic layer is the whole job. Same
  // no-gateway-dependency posture as note-quality-enqueue below — a derived-state tick must not
  // depend on the generative plane being configured. Wire `judge` here if that changes.
  registerEpisodeEvaluation(scheduler, {
    edb: deps.experientialDb,
    intervalMs: deps.intervalMs,
    onError: stderrOnError("episode-evaluation"),
  });
  // THE-643: own cadence, not the roles-gated plane-enqueue above — no gateway dependency.
  scheduler.register({
    name: "note-quality-enqueue",
    intervalMs: deps.intervalMs,
    run: () => {
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
      run: () => {
        deps.jobQueue.enqueue("citation", {
          class: "plane",
          idempotencyKey: `citation:${Math.floor(Date.now() / bucketMs)}`,
          maxAttempts: 1,
        });
      },
      onError: stderrOnError("citation-enqueue"),
    });
  }
  // THE-633: the goal expiry sweep. Registered HERE, in the same change that adds the table, and
  // deliberately so — an expiry function with no scheduled caller is precisely the shape this
  // codebase keeps producing (THE-698's evaluator, THE-717's citation pass, THE-719's gaps pass:
  // correct code, complete tests, no caller, invisible from inside the repo). A goals table whose
  // sweep never ran would silently become a list of things the user gave up on, biasing every
  // downstream read toward stale intent — which is the exact failure the migration header calls out.
  //
  // Direct, not enqueued: this is a single bounded UPDATE over one indexed predicate, with no
  // gateway dependency and nothing to retry. The durable job queue is for work that can fail
  // halfway; this cannot.
  scheduler.register({
    name: "goal-expiry",
    intervalMs: deps.intervalMs,
    run: () => {
      expireOverdueGoals(deps.experientialDb, Date.now());
    },
    onError: stderrOnError("goal-expiry"),
  });
}
