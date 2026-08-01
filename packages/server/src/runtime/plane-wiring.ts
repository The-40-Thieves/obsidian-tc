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
import { recomputeNoteQualityAll } from "../experiential/note-quality";
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
  /** config.vaults */
  vaults: VaultConfigInput[];
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
    const planeCtx = { db: deps.db, roles, now: Date.now };
    const synthesisJob = wrapPlaneJob("synthesis", () => runSynthesis(planeCtx));
    const auditPassJob = wrapPlaneJob("audit", () => auditJob.run(planeCtx));
    jobHandlers.set("synthesis", synthesisJob);
    jobHandlers.set("audit", auditPassJob);
  }
  // THE-643: note_quality was write-only (an unused CLI command); no gateway dependency here.
  if (deps.experientialOpen) {
    const vaultIds = deps.vaults.map((v) => v.id);
    const noteQualityJob = wrapPlaneJob("note-quality", async () => ({
      ok: true,
      detail: {
        per_vault: recomputeNoteQualityAll(deps.db, deps.experientialDb, vaultIds, Date.now()),
      },
    }));
    jobHandlers.set("note-quality", noteQualityJob);
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
      deps.jobQueue.enqueue("synthesis", {
        class: "plane",
        idempotencyKey: `synthesis:${iso.year}-${iso.week}`,
        maxAttempts: 1,
      });
      const day = new Date().toISOString().slice(0, 10);
      deps.jobQueue.enqueue("audit", {
        class: "plane",
        idempotencyKey: `audit:${day}`,
        maxAttempts: 1,
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
  },
): void {
  if (!deps.experientialOpen) return;
  wireActivationRecompute(scheduler, deps.observability, {
    edb: deps.experientialDb,
    intervalMs: deps.intervalMs,
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
}
