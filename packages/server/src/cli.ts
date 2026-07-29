// THE-466 slice 1: the one-shot CLI handlers (run_version, run_doctor, run_forget, etc.) live in
// ./cli/commands/*, and shared dispatch plumbing (Cmd<K>, resolveOrUsageExit, experientialMigrations)
// in ./cli/shared.ts. This file grew 37% (1483 -> 2027 lines) between when THE-466 was filed and
// when it was picked up, unnoticed until a probe measured it — after slice 1 it was dispatch +
// run_serve only, at 1278 lines. biome.json's per-file `noExcessiveLinesPerFile` override (scoped
// to this path) is the floor gate so a future regrowth trips `bun run lint` instead of going
// unnoticed again.
//
// THE-466 slice 2: run_serve's own observability wiring (MetricsRecorder, its gauge sources,
// onVecFallback/onStageMetric/sqlHooksFor, the MORGIANA emitter — see THE-585's history of gauges
// that were declared and never wired) moved to ./runtime/observability.ts, where it is unit
// testable against a real recorder instead of buried inside a 1000+ line boot function. This file
// onIndexVaultComplete wiring); the maxLines cap in biome.json sits just above the measured size.
// THE-610 raised it (1245 -> see biome.json) to wire the sweep's filesystem arm: there was ZERO
// headroom, and golfing under the old limit had already produced a duplicated DEFAULT_TRACE_FOLDER
// literal. A cap only ever raised is not a gate — THE-466's next slice must ratchet it back DOWN.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MEMORY_FOLDER } from "@the-40-thieves/obsidian-tc-shared";
import { version as VERSION } from "../package.json";
import { FolderAcl, makeIndexReadable, makeReindexGate } from "./acl";
import {
  type BridgeClient,
  buildVaultCapabilities,
  CapabilityCache,
  checkBridgeCompat,
  createBridgeClient,
  formatCompatWarning,
} from "./bridge";
import { parseCliArgs } from "./cli/args";
import { run_activation_recompute } from "./cli/commands/activation-recompute";
import { run_citation_infer } from "./cli/commands/citation-infer";
import { run_cluster } from "./cli/commands/cluster";
import { run_config_explain } from "./cli/commands/config-explain";
import { run_config_show } from "./cli/commands/config-show";
import { run_contribution_report } from "./cli/commands/contribution-report";
import { run_densify_llm } from "./cli/commands/densify-llm";
import { run_doctor } from "./cli/commands/doctor";
import { run_error } from "./cli/commands/error";
import { run_forget } from "./cli/commands/forget";
import { run_gaps } from "./cli/commands/gaps";
import { run_help } from "./cli/commands/help";
import { run_metrics } from "./cli/commands/metrics";
import { run_note_quality } from "./cli/commands/note-quality";
import { run_plugin_install } from "./cli/commands/plugin-install";
import { run_prefetch } from "./cli/commands/prefetch";
import { run_reflect } from "./cli/commands/reflect";
import { run_token_mint } from "./cli/commands/token-mint";
import { run_version } from "./cli/commands/version";
import { type Cmd, experientialMigrations, resolveOrUsageExit } from "./cli/shared";
import { provisionExperientialDb } from "./db/experiential";
import { openDatabase } from "./db/open";
import { provisionCacheDb } from "./db/provision";
import { elicitVerifier, setDefaultElicitTtlSeconds } from "./elicit";
import { createEmbeddingProvider } from "./embeddings";
import { makeActivationLookup } from "./experiential/activation";
import { createEpisodeCapture } from "./experiential/episodes";
import { createRetrievalLogger } from "./experiential/log";
import { createGatewayClient, type GatewayClient } from "./gateway";
import { type CallerContext, ToolRegistry } from "./mcp/registry";
import { createMcpServer } from "./mcp/server";
import { TASK_CALL_JOB_TYPE } from "./mcp/tasks";
import { startMetricsEndpoint } from "./metrics/endpoint";
import { recordIngestStats } from "./metrics/ingest-stats";
import { buildModelTierReranker } from "./model";
import { initOtel } from "./otel/tracing";
import type { GatewayRoles } from "./plane/gateway";
import { auditJob } from "./plane/jobs/audit";
import { checkContradictions, loadChunkForContradiction } from "./plane/jobs/contradiction";
import { isoWeek, runSynthesis } from "./plane/jobs/synthesis";
import { createPlurBackend } from "./plur/client";
import { configureMaintenance } from "./runtime/maintenance-wiring";
import { createObservability, wireActivationRecompute } from "./runtime/observability";
import { applyReconcileOutcome } from "./runtime/reconcile-outcome";
import { JobQueue } from "./scheduler/job-queue";
import { type JobHandler, makeJobRunner } from "./scheduler/job-runner";
import { Scheduler } from "./scheduler/scheduler";
import { makeTaskCallHandler } from "./scheduler/task-call-runner";
import { ensureNotesFts } from "./search/fts";
import { IndexCoordinator } from "./search/index-coordinator";
import {
  deindexNote,
  type IndexHook,
  type IndexStats,
  indexNote,
  indexVault,
} from "./search/indexer";
import { nativeLoaded } from "./search/native";
import { createRetrievalCaches } from "./search/query_cache";
import {
  CHUNKER_VERSION,
  ENRICHMENT_VERSION,
  VEC_DISTANCE_METRIC,
  VEC_SCHEMA_GEN,
} from "./search/representation";
import type { Reranker } from "./search/rerank";
import { ensureVecChunks } from "./search/vec";
import { RateLimiter } from "./throttle";
import { createHealthTool, createIndexStatusTool } from "./tools/admin/health";
import { registerM1Tools } from "./tools/m1";
import { registerM2Tools } from "./tools/m2";
import { registerM3Tools } from "./tools/m3";
import {
  type BridgeTimeouts,
  bridgeTimeouts,
  DEFAULT_BRIDGE_TIMEOUTS,
  type M4Deps,
  openBridge,
  registerM4Tools,
} from "./tools/m4";
import { DEFAULT_TRACE_FOLDER, registerM5Tools } from "./tools/m5";
import { type M6Deps, registerM6Tools } from "./tools/m6";
import { registerM7Tools } from "./tools/m7";
import { registerM8Tools } from "./tools/m8";
import { startHttp } from "./transports/http";
import { connectStdio } from "./transports/stdio";
import { resolveMode, type VaultMode } from "./vault/mode";
import { contentHash, resolveVaultPath } from "./vault/paths";
import { VaultRegistry } from "./vault/registry";
import { registerVaultWatch } from "./vault/watcher";
import { ActiveSessionTracker, appendTrace, getSession } from "./workspace/sessions";

// VERSION derives from packages/server/package.json (imported above): single source of
// truth, bumped by the release pipeline. Matches MCP versioning guidance (extract from
// package metadata, do not hardcode); resolveJsonModule is on, so bun inlines it at build.

/** THE-466 slice 2: indexCoordinator/scheduler are constructed after the observability module, so
 *  its gauge sources read them through a ref assigned later — read only lazily, at scrape time,
 *  always after boot has finished. A plain thrown Error (never a non-null assertion, forbidden by
 *  lint) documents the invariant if that ever stops being true. */
function requireBoot<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} read before boot completed`);
  return value;
}

async function run_serve(cmd: Cmd<"serve">): Promise<void> {
  const config = resolveOrUsageExit(cmd.input);
  const configPath = cmd.input ?? process.env.OBSIDIAN_TC_CONFIG;
  const firstVault = config.vaults[0];
  if (!firstVault) throw new Error("config.vaults must contain at least one vault");
  const startedAt = Date.now();

  mkdirSync(config.cacheDir, { recursive: true });
  const db = await openDatabase(join(config.cacheDir, "cache.db"));
  provisionCacheDb(db, { version: VERSION });
  // THE-233 (W-SCHEMA): provision the experiential tier as a physically separate store (the
  // membrane — low-trust per-retrieval state cannot FK into the authored atoms in cache.db,
  // and a reset is a file truncate).
  const experientialDb = await provisionExperientialDb(config.cacheDir, experientialMigrations, {
    version: VERSION,
  });
  // THE-230/THE-228: the experiential capture port. Retrieval logging + the episode bus share
  // the one experiential.db handle, held open for the process lifetime when either is enabled;
  // with both off the store is provisioned-then-released (pre-capture behavior). Sink failures
  // go to stderr and never fail the dispatch/search that fired them (best-effort telemetry).
  const retrievalLog = config.experiential.logRetrievals
    ? createRetrievalLogger(experientialDb, {
        onError: (e) =>
          process.stderr.write(`[retrieval-log] ${e instanceof Error ? e.message : String(e)}\n`),
      })
    : undefined;
  // THE-228: capture-everything episode bus (agent_episodes). The content axis (raw args) is
  // a separate gate, default OFF until the THE-238 poisoning defense lands.
  const episodeCapture = config.experiential.captureEpisodes
    ? createEpisodeCapture(experientialDb, {
        captureContent: config.experiential.captureContent,
        onError: (e) =>
          process.stderr.write(`[episodes] ${e instanceof Error ? e.message : String(e)}\n`),
      })
    : undefined;
  // THE-187/193: serve-side activation lookup for the bubble pass — dark unless activationRerank.
  const activationFor = config.experiential.activationRerank
    ? makeActivationLookup(experientialDb, {
        onError: (e) =>
          process.stderr.write(`[activation-read] ${e instanceof Error ? e.message : String(e)}\n`),
      })
    : undefined;
  const experientialOpen = !!(retrievalLog || episodeCapture || activationFor);
  if (!experientialOpen) experientialDb.close?.();

  // Prometheus recorder (G2.4) — always live so get_metrics and the optional /metrics scrape
  // share the same in-memory counters. The scrape endpoint is started below only when
  // observability.prometheus.enabled (default off / `:0`).
  // OTEL tracing (G2.4) — no-op unless observability.otel.endpoint is set.
  const otel = await initOtel(config.observability, VERSION);
  // THE-507: hoisted ABOVE the recorder so its stats can be a gauge source. Construction is
  // unconditional now (it was inline under the retrieval-cache config branch), which is safe
  // because an unused cache is two empty Maps — but it is still only THREADED to the tools when
  // the feature is enabled, so behaviour is unchanged when it is off. What changes is that the
  // metrics then read a cache nobody writes and report all-zero, which is the honest reading.
  const retrievalCaches = createRetrievalCaches({
    maxEntries: config.retrieval.cache.maxEntries,
    ttlMs: config.retrieval.cache.ttlSeconds * 1000,
  });
  // THE-585 (#11): set once, when the HTTP transport is constructed, below. Null until then, and
  // null forever on a stdio-only server — see observability.ts's httpConstructSeconds source.
  let httpConstructSeconds: number | null = null;
  // indexCoordinator and scheduler are constructed further down (after the tool registry); the
  // observability module reads them through these lazily-assigned refs so its gauge sources see
  // the live objects at scrape time without the recorder having to be constructed after them.
  let indexCoordinatorRef: IndexCoordinator | undefined;
  let schedulerRef: Scheduler | undefined;
  // THE-466 slice 2: MetricsRecorder + its gauge sources, onVecFallback/onStageMetric/sqlHooksFor,
  // and the MORGIANA emitter all live in runtime/observability.ts now — see that file for the
  // THE-585 history (three gauges that were declared and never wired) this extraction fixes.
  const observability = createObservability({
    db,
    cacheDir: config.cacheDir,
    morgianaSpool: config.observability.morgiana.spool,
    retrievalCaches,
    getIndexCoordinatorStats: () => requireBoot(indexCoordinatorRef, "indexCoordinator").stats(),
    getSchedulerStats: () => requireBoot(schedulerRef, "scheduler").stats(),
    getHttpConstructSeconds: () => httpConstructSeconds,
  });
  const { metrics, onVecFallback, onStageMetric, sqlHooksFor, morgiana, onSnapshotSkipped } =
    observability;
  // Shared rate limiter (G2.4 tiers) — the dispatch gate (THE-210) and get_metrics share it.
  const rateLimiter = new RateLimiter(config.throttle.tiers);
  const vaultRegistry = new VaultRegistry(config.vaults, process.env.OBSIDIAN_TC_DEFAULT_VAULT);
  // THE-209: process-local active-session tracker; start_session/end_session maintain it and
  // the stdio context factory reads it to stamp ctx.sessionId for dispatch-level tracing.
  const activeSessions = new ActiveSessionTracker();
  // THE-295: root ACL + per-vault overrides (root is the inherited default), hoisted above the
  // registry so dispatch's aclResolver can swap ctx.acl per requested vault.
  const acl = new FolderAcl(config.acl);
  const aclByVault = new Map(
    config.vaults
      .filter((v) => v.acl !== undefined)
      .map((v) => [v.id, new FolderAcl(v.acl as ConstructorParameters<typeof FolderAcl>[0])]),
  );
  // THE-302: the configured elicit-token TTL governs every HITL token mint (issueElicitToken falls
  // back to this default when a caller passes no explicit ttlSeconds). Set once at startup.
  setDefaultElicitTtlSeconds(config.elicitTtlSeconds);
  const registry = new ToolRegistry({
    maxResponseBytes: config.governor.maxResponseBytes,
    idempotencyTtlSeconds: config.idempotencyTtlSeconds,
    idempotencyReclaimSeconds: config.idempotencyReclaimSeconds,
    verifyElicit: elicitVerifier,
    metrics,
    tracer: otel.tracer,
    emit: (vaultId, type, data) => morgiana.emit(vaultId, type, data),
    // THE-288: honor throttle.enabled — when false the dispatch gate gets no limiter and never
    // throttles. The RateLimiter object still exists (below) so get_metrics keeps reporting.
    rateLimiter: config.throttle.enabled ? rateLimiter : undefined,
    toolVisibility: config.toolVisibility,
    // THE-295: per-vault ACL enforcement at dispatch.
    aclResolver: (vaultId) => aclByVault.get(vaultId) ?? acl,
    // THE-414: vault-root resolver so dispatch can run central pathAcl enforcement with the same
    // symlink-canonical enforcePathAcl the handlers use. Unknown vaults resolve to undefined
    // (central enforcement then skips; the vault-binding guard already rejects cross-vault access).
    rootResolver: (vaultId) => {
      try {
        return vaultRegistry.resolve(vaultId).root;
      } catch {
        return undefined;
      }
    },
    // THE-569: reverse vault-kind gate — a mutating dispatch refuses to reach a docs/system-kind
    // vault, closing the write/integrity direction of P1.5. Unknown vaults resolve to undefined
    // (the gate then no-ops; the vault-binding guard and pathAcl stage already reject them).
    vaultKindResolver: (vaultId) => {
      try {
        return vaultRegistry.resolve(vaultId).kind;
      } catch {
        return undefined;
      }
    },
    // THE-209: append a per-invocation trace record to the active session's JSONL trace.
    sessionTracer: (session, record) => {
      try {
        const row = getSession(db, session.sessionId);
        if (!row || row.ended_at !== null || row.vault_id !== session.vaultId) return;
        const abs = resolveVaultPath(vaultRegistry.resolve(row.vault_id).root, row.trace_path);
        appendTrace(abs, record);
      } catch {
        /* best-effort: tracing never breaks a dispatch */
      }
    },
    onProfile:
      process.env.OBSIDIAN_TC_PROFILE === "1"
        ? (p) =>
            process.stderr.write(
              `[profile] ${p.tool} total=${p.total_ms}ms handler=${p.handler_ms}ms overhead=${p.total_ms - p.handler_ms}ms\n`,
            )
        : undefined,
    // THE-288: a non-typed handler throw is redacted to `{code:"internal"}` for the client; the
    // real error + stack goes to stderr (never stdout, the MCP channel) for operator diagnosis.
    onInternalError: (tool, vaultId, e) => {
      const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
      process.stderr.write(`[internal] ${tool} (vault ${vaultId}): ${detail}\n`);
    },
    // THE-457: a fail-open audit write that threw is already metered; also bump the health counter
    // so server_health shows the audit trail going lossy. Runs only at dispatch (after indexHealth
    // is initialized).
    // THE-417 Phase 2: route drift to a counter so warn-mode has a readable output. The stderr
    // line above stays — it carries the Zod issues a human needs to diagnose; this is the half a
    // dashboard can alert on.
    onOutputSchemaDrift: (tool, vaultId) => metrics.incOutputSchemaDrift(vaultId, tool),
    onAuditFailure: () => {
      indexHealth.auditWriteFailures++;
    },
    // THE-228: every dispatch outcome feeds the experiential episode bus (when enabled).
    ...(episodeCapture ? { onEpisode: episodeCapture } : {}),
  });
  // Index-on-write (THE-255): a note mutation reindexes its path inline (best-effort and
  // backgrounded, so it never slows or fails a write); deindex drops a removed note's chunks
  // via an empty-content reindex (no embedding call). The boot reconcile guarantees full
  // convergence. Shares the one embedding provider + vec-availability flag.
  const embeddingProvider = createEmbeddingProvider(config.embeddings);
  // GH #171/#172: thread the embed-batch knobs into every reconcile so local runners are tunable.
  const embedConfig = {
    batchSize: config.embeddings.batchSize,
    concurrency: config.embeddings.concurrency,
    maxBatchTokens: config.embeddings.maxBatchTokens,
  };
  // THE-460: same fingerprint scheme as indexVault — provider/model/dims + the fixed
  // representation constants + whether chunkContext enrichment is on, so a same-dimension model
  // swap or an enrichment/chunker change rebuilds vec_chunks instead of serving it stale.
  const hasVec = ensureVecChunks(
    db,
    {
      provider: embeddingProvider.provider,
      model: embeddingProvider.model,
      dimensions: embeddingProvider.dimensions,
      distanceMetric: VEC_DISTANCE_METRIC,
      enrichmentVersion: config.embeddings.chunkContext ? ENRICHMENT_VERSION : 0,
      chunkerVersion: CHUNKER_VERSION,
      schemaGen: VEC_SCHEMA_GEN,
    },
    { now: Date.now, onRebuild: observability.onVecRebuild },
  );
  // THE-291: FTS5 probe (trigram notes_fts) — false on adapters without FTS5 or when
  // OBSIDIAN_TC_DISABLE_FTS=1; the query layer then keeps the disk-scan floor.
  const hasFts = ensureNotesFts(db, { now: Date.now });
  // THE-288: mutable index-health tracker surfaced by server_health. reconcile flips pending ->
  // ok/degraded when the boot reconcile settles; writeFailures counts swallowed index-on-write
  // errors (reindex/deindex best-effort). The health tool reads a snapshot at call time.
  const indexHealth: {
    reconcile: "pending" | "ok" | "degraded";
    reconcileAt: number | null;
    reconcileErrors: Array<{ vault: string; error: string }>;
    writeFailures: number;
    lastWriteError?: string;
    /** THE-291: the notes/FTS metadata pass completed (independent of embed success). */
    notesReady: boolean;
    /** THE-457: fail-open audit writes that threw (locked DB / disk full) — the audit trail is lossy. */
    auditWriteFailures: number;
    /** THE-458 (audit #5): times the index-on-write queue depth crossed queueMax (backpressure edges). */
    indexQueueBackpressures: number;
    /** THE-491: chunks_upserted from the most recent index_vault tool call; null until the first
     *  one this process (get_index_status surfaces it verbatim). */
    lastChunksUpserted: number | null;
  } = {
    reconcile: "pending",
    reconcileAt: null,
    reconcileErrors: [],
    writeFailures: 0,
    notesReady: false,
    auditWriteFailures: 0,
    indexQueueBackpressures: 0,
    lastChunksUpserted: null,
  };
  // #14: durable contradiction jobs (was an in-memory queue that dropped under backpressure).
  // Constructed here (ahead of its original ~line-1006 site) so server_health's getJobQueueStats
  // accessor below can close over it; it depends only on `db` + `Date.now`, both already
  // available at this point in boot.
  // THE-585 (#5): the job queue claims across every vault from one process-wide connection, so it
  // has no vault id to report; "scheduler" is the bounded subsystem name, matching the precedent
  // the query-cache gauges set for process-wide subsystems.
  const jobQueue = new JobQueue(db, { now: Date.now, sql: sqlHooksFor("scheduler") });
  // server_health surfaces the build's active fast-paths (native module + sqlite-vec). Both are
  // non-identifying, so the tool keeps them in its unauthenticated payload; registered here (not
  // earlier) so hasVec is known.
  registry.register(
    createHealthTool({
      version: VERSION,
      vaults: config.vaults.map((v) => v.id),
      startedAt,
      nativeLoaded,
      vecEnabled: hasVec,
      ftsEnabled: hasFts,
      getIndexHealth: (authenticated) => ({
        reconcile: indexHealth.reconcile,
        reconcile_at: indexHealth.reconcileAt,
        write_failures: indexHealth.writeFailures,
        notes_ready: indexHealth.notesReady,
        ...(authenticated
          ? {
              detail: {
                reconcile_errors: indexHealth.reconcileErrors,
                audit_write_failures: indexHealth.auditWriteFailures,
                // THE-458 (audit #5): index-on-write coordinator depth + backpressure.
                index_queue_depth: indexCoordinator.stats().queued,
                index_queue_active: indexCoordinator.stats().active,
                index_queue_backpressures: indexHealth.indexQueueBackpressures,
                ...(indexHealth.lastWriteError !== undefined
                  ? { last_write_error: indexHealth.lastWriteError }
                  : {}),
              },
            }
          : {}),
      }),
      getJobQueueStats: () => jobQueue.stats(),
    }),
  );
  // THE-491: get_index_status — a thin, named, agent-discoverable reader over the same
  // index-health state, so a caller can self-diagnose before spending on an expensive search
  // without pulling in server_health's full (and authenticated-gated) payload.
  registry.register(
    createIndexStatusTool({
      vecEnabled: hasVec,
      ftsEnabled: hasFts,
      getIndexHealth: () => ({
        reconcile: indexHealth.reconcile,
        reconcile_at: indexHealth.reconcileAt,
        write_failures: indexHealth.writeFailures,
        notes_ready: indexHealth.notesReady,
      }),
      getLastChunksUpserted: () => indexHealth.lastChunksUpserted,
    }),
  );

  // THE-233 integration — optional inference gateway (W-GATEWAY-CLIENT). Unconfigured (no
  // OBSIDIAN_TC_GATEWAY_URL) -> null; every generative seam below degrades gracefully rather
  // than failing boot (createGatewayClient throws without a base URL, so guard with try).
  let gateway: GatewayClient | null = null;
  try {
    gateway = createGatewayClient({});
  } catch {
    gateway = null;
  }
  const gw = gateway;
  // W-RETRIEVAL rerank seam -> gateway /rerank passthrough (graceful no-op fallback when null).
  const gatewayReranker: Reranker | null = gw
    ? (q, docs, topN) => gw.rerank({ query: q, documents: docs, topN }).then((r) => r.results)
    : null;
  // Prefer the model-tier BGE /v1/rerank (bge-reranker-v2-m3) when its service is configured;
  // else the gateway passthrough. Dark until a rerank stage is enabled in graphSearch.
  const reranker: Reranker | null = buildModelTierReranker(config.embeddings) ?? gatewayReranker;
  // W-WORKERS generative seam -> gateway extract/synthesize/judge roles (null -> jobs/challenge no-op).
  const roles: GatewayRoles | null = gw
    ? {
        extract: (r) => gw.extract(r).then((x) => ({ text: x.text, model: x.model })),
        synthesize: (r) => gw.synthesize(r).then((x) => ({ text: x.text, model: x.model })),
        judge: (r) => gw.judge(r).then((x) => ({ text: x.text, model: x.model })),
      }
    : null;
  // W-INGEST onIndexed hook -> contradiction-check enqueue. The detector needs the gateway, so we
  // only enqueue when roles are present. `jobQueue` itself is constructed earlier (ahead of the
  // server_health registration above) so its stats accessor can be wired there.
  const CONTRADICTION_MAX_ATTEMPTS = 3;
  const CONTRADICTION_DRAIN_MS = 15_000;

  // THE-507/THE-588: recordIngestStats lives in ./metrics/ingest-stats so the production wiring
  // between a real IndexStats pass and the Prometheus counters is importable and testable directly
  // (see its module doc comment for why).
  const recordIngestStatsFor = (vaultId: string, s: IndexStats): IndexStats => {
    recordIngestStats(db, metrics, vaultId, s);
    return s;
  };
  // THE-625 item 4: routes both direct indexVault(...) callers below through this recorder instead
  // of a per-call-site reminder (THE-590 found one caller left uninstrumented).
  const indexVaultRecorded = (opts: Parameters<typeof indexVault>[0]) =>
    indexVault(opts).then((s) => recordIngestStatsFor(opts.vaultId, s));

  // THE-457: cap on how long graceful shutdown waits for in-flight index work.
  const SHUTDOWN_DRAIN_MS = 5000;
  const makeOnIndexed = (vaultId: string): IndexHook | undefined =>
    roles
      ? (chunks) => {
          for (const c of chunks) {
            jobQueue.enqueue("contradiction", {
              class: "contradiction",
              // THE-571: ids only. The chunk (incl. its dense embedding) used to be JSON-encoded
              // into jobs.payload on every enqueue; the handler re-reads it at run time instead,
              // which is both smaller and fresher — a payload vector is a snapshot from enqueue
              // time, so a re-embed before the job ran would have been judged on the OLD vector.
              payload: { vaultId, chunkId: c.id },
              // Content-sensitive key: chunk.id (chunkId(vaultId, path, index)) is deterministic
              // from PATH+POSITION, not content, and enqueue() dedups against a completed job's
              // row forever (jobs are never pruned). Keying on id alone would mean editing a note
              // silently produces NO new job — the id repeats, enqueue() returns the old completed
              // row — even though the indexer just deleted that chunk's prior contradiction flags
              // on re-embed, expecting this hook to regenerate them. Folding in the content hash
              // makes an edit (new content) a distinct key -> re-judged; an identical-content
              // rapid re-index still dedups to the same key, exactly as the in-memory drainer's
              // transient per-drain dedup did before THE-570 removed it.
              idempotencyKey: `${vaultId}:${c.id}:${contentHash(c.content)}`,
              maxAttempts: CONTRADICTION_MAX_ATTEMPTS,
              // #14: a completed or dead-lettered job for this exact key must not permanently block
              // re-judging recurring identical content (revert, or re-index after dead-letter) — see
              // EnqueueOptions.replaceIfTerminal. The plane (synthesis/audit) producers deliberately
              // do NOT set this; their once-per-period dedup against a terminal row is correct.
              replaceIfTerminal: true,
            });
          }
        }
      : undefined;
  const jobHandlers = new Map<string, JobHandler>();
  jobHandlers.set(TASK_CALL_JOB_TYPE, makeTaskCallHandler({ registry, db, acl, queue: jobQueue }));
  if (roles) {
    jobHandlers.set("contradiction", async (job) => {
      const { vaultId, chunkId } = job.payload as { vaultId: string; chunkId: string };
      const chunk = loadChunkForContradiction(db, vaultId, chunkId);
      // Deleted or re-embedded between enqueue and run — a normal race, not a failure. Returning
      // marks the job complete; THROWING here would dead-letter a job that did nothing wrong.
      if (!chunk) return;
      const jobCtx = { db, roles, now: Date.now, model: embeddingProvider.id };
      const r = await checkContradictions(jobCtx, vaultId, [chunk]);
      // THE-613: an unjudged pair is a FAILURE, not a clean result — the same contract the
      // synthesis handler below states. Retry is safe (INSERT OR IGNORE on a content-derived id).
      if (r.unjudged > 0) throw new Error(`contradiction: ${r.unjudged}/${r.checked} unjudged`);
    });
    // #14: the plane consolidation (weekly synthesis + daily audit) is now durable jobs too — see
    // the plane-enqueue scheduler below. runSynthesis/auditJob.run report failure via
    // JobResult.ok:false rather than throwing (e.g. parseSynthesis rejecting a malformed LLM
    // response) — the runner's dead-letter/retry machinery only reacts to a THROW, so an ok:false
    // must be turned into one here or a real failure gets recorded as `complete` and silently
    // vanishes (worse than the pre-migration behavior this ticket exists to fix). `{ok:true,
    // detail:{skipped:...}}` (e.g. no chunks yet) is NOT a failure and correctly falls through.
    jobHandlers.set("synthesis", async () => {
      const r = await runSynthesis({ db, roles, now: Date.now });
      if (!r.ok) throw new Error(`synthesis job failed: ${JSON.stringify(r.detail ?? {})}`);
    });
    jobHandlers.set("audit", async () => {
      const r = await auditJob.run({ db, roles, now: Date.now });
      if (!r.ok) throw new Error(`audit job failed: ${JSON.stringify(r.detail ?? {})}`);
    });
  }
  const jobRunner = makeJobRunner({
    queue: jobQueue,
    leaseOwner: `serve:${process.pid}`,
    handlers: jobHandlers,
    classLimits: { contradiction: 4, plane: 1 },
    // outcomes are surfaced via server_health stats, not per-job logging; onOutcome left unset
  });

  // THE-291 (part 2): shared index-on-write hooks for the non-M1 writers (m3 periodic, m4
  // tasks, m5 capture, m6 bulk). M1 keeps its identical inline closures from THE-255.
  // THE-455: route every index-on-write mutation through a per-(vault,path) coordinator so same-path
  // writes/deletes serialize (newest wins — no stale/out-of-order commit, no delete resurrection)
  // while different paths stay concurrent. Handlers are the same indexNote/deindexNote as before.
  const indexCoordinator = new IndexCoordinator(
    {
      write: (vaultId, path, content) =>
        indexNote(
          db,
          embeddingProvider,
          vaultId,
          path,
          content,
          hasVec,
          Date.now,
          makeOnIndexed(vaultId),
          config.embeddings.chunkContext,
          sqlHooksFor(vaultId),
        ),
      delete: (vaultId, path) =>
        deindexNote(
          db,
          vaultId,
          path,
          hasVec,
          config.embeddings.chunkContext,
          sqlHooksFor(vaultId),
        ),
      onError: (e) => {
        indexHealth.writeFailures++;
        indexHealth.lastWriteError = e instanceof Error ? e.message : String(e);
      },
    },
    {
      // THE-458 (audit #5): bound concurrent index/embed fan-out so a bulk mutation cannot spawn an
      // unbounded number of simultaneous embedding calls; surface sustained queue depth in health.
      globalConcurrency: config.indexing.writeConcurrency,
      perVaultConcurrency: config.indexing.writeConcurrencyPerVault,
      queueMax: config.indexing.queueMax,
      onBackpressure: (depth) => {
        indexHealth.indexQueueBackpressures++;
        process.stderr.write(
          `[index] write-queue backpressure: ${depth} distinct paths pending (> queueMax ` +
            `${config.indexing.queueMax}); index/embed fan-out is capped, writes are queued not dropped\n`,
        );
      },
    },
  );
  // THE-466 slice 2: hand the live coordinator to the observability module's lazy gauge sources
  // (indexQueueDepth / indexActive / indexCoalesced), constructed above before this existed.
  indexCoordinatorRef = indexCoordinator;
  // indexReadableFor: per-vault ACL read-visibility filter shared by the boot reconcile, runtime
  // add_vault, AND the index-on-write hook below (THE-453). makeIndexReadable resolves each vault's
  // effective ACL (override ?? root), mirroring the dispatch aclResolver, so indexing never
  // reads/embeds a vault-denied path.
  const indexReadableFor = makeIndexReadable(acl, aclByVault);
  // THE-453 (runtime): gate index-on-write through the effective read ACL. A write handler passes the
  // WRITE ACL then calls reindex; a write-allowed but read-denied path (writePaths ⊃ readPaths) must
  // not be embedded — makeReindexGate routes it to submitDelete (evicting any stale index state)
  // instead of submitWrite. Deletes are always safe, so deindex stays a direct submitDelete.
  const reindexHook = makeReindexGate(indexReadableFor, {
    write: (vaultId, path, content) => indexCoordinator.submitWrite(vaultId, path, content),
    delete: (vaultId, path) => indexCoordinator.submitDelete(vaultId, path),
  });
  const deindexHook = (vaultId: string, path: string): void =>
    indexCoordinator.submitDelete(vaultId, path);
  // THE-649: make docs/SYNC.md's long-standing claim true — every sync tier it documents delivers
  // notes by writing to disk, and nothing was watching. Feeds the SAME reindexHook the write path
  // uses, so a watched change is read-ACL-gated identically to a write_note. Vaults registered later
  // by add_vault are not watched; config.vaults is the boot set, matching resolveTraceDirs' scope.
  const stopVaultWatch = registerVaultWatch(config.vaults, config.watch, {
    onUpsert: reindexHook,
    onDelete: deindexHook,
  });
  registerM1Tools(registry, {
    vaultRegistry,
    version: VERSION,
    startedAt,
    embeddings: { provider: config.embeddings.provider, model: config.embeddings.model },
    configPath,
    // THE-374: config-gated snapshot-on-write policy (default off).
    snapshots: { enabled: config.snapshots.enabled, retention: config.snapshots.retention },
    // THE-603: legibility signal when the above no-ops for a destructive write.
    onSnapshotSkipped,
    // THE-291 (3B): metadata tools read the notes table once the boot notes pass commits.
    metadataIndex: { hasFts, ready: () => indexHealth.notesReady },
    requireCas: config.writes.requireCas,
    // THE-455: M1 shares the coordinator-backed hooks (was an identical inline indexNote/deindexNote).
    reindex: reindexHook,
    deindex: deindexHook,
    // THE-376: runtime add_vault triggers a full index of the newly registered vault
    // (mirrors the boot reconcile below). indexReadableFor is defined just above.
    indexVault: async (vaultId) => {
      const s = await indexVaultRecorded({
        db,
        provider: embeddingProvider,
        embed: embedConfig,
        chunkContext: config.embeddings.chunkContext,
        densify: config.retrieval.densify,
        vaultId,
        root: vaultRegistry.resolve(vaultId).root,
        isReadable: indexReadableFor(vaultId),
        now: Date.now,
        sql: sqlHooksFor(vaultId),
        onVecRebuild: observability.onVecRebuild,
        onIndexed: makeOnIndexed(vaultId),
        onNotesPass: () => {
          indexHealth.notesReady = true;
        },
        // THE-490/THE-591: indexing.streamingWalk. Off by default -> byte-identical to before.
        walk: { streaming: config.indexing.streamingWalk },
      });
      return { notes_seen: s.notes_seen };
    },
  });
  // M4 plugin bridges (THE-180): per vault, build a bridge client to the companion
  // plugin's Local REST API surface (base URL + bearer key from vault config/env,
  // never logged) and probe it once at startup for its plugin-capability map. A
  // vault with no restApiUrl gets no client; its bridge tools then degrade to
  // plugin_unreachable. The probe never throws — a missing or unreachable companion
  // degrades only the bridge tools, leaving startup and the filesystem tools intact.
  // Built before M2 so search_dql can share the same Dataview bridge.
  const bridgeClients = new Map<string, BridgeClient>();
  const timeoutsByVault = new Map<string, BridgeTimeouts>();
  const commandsByVault = new Map<string, { enabled: boolean; allowlist: string[] }>();
  const memoryFolderByVault = new Map<string, string>();
  const traceFolderByVault = new Map<string, string>();
  const capabilities = new CapabilityCache();
  for (const v of config.vaults) {
    commandsByVault.set(v.id, {
      enabled: v.commands?.enabled ?? false,
      allowlist: v.commands?.allowlist ?? [],
    });
    if (v.memory) memoryFolderByVault.set(v.id, v.memory.folder);
    if (v.workspace) traceFolderByVault.set(v.id, v.workspace.traceFolder);
    if (v.bridges)
      timeoutsByVault.set(v.id, {
        timeoutMs: v.bridges.timeoutMs,
        ocrTimeoutMs: v.bridges.ocrTimeoutMs,
        templaterTimeoutMs: v.bridges.templaterTimeoutMs,
      });
    const client = v.restApiUrl
      ? createBridgeClient({
          baseUrl: v.restApiUrl,
          apiKey: v.restApiKey,
          timeoutMs: v.bridges?.timeoutMs,
        })
      : undefined;
    if (client) bridgeClients.set(v.id, client);
    const snap = await buildVaultCapabilities(client, {
      probeSkip: v.plugins?.probeSkip,
      forceEnabled: v.plugins?.forceEnabled,
      forceDisabled: v.plugins?.forceDisabled,
      timeoutMs: v.bridges?.probeTimeoutMs,
    });
    capabilities.set(v.id, snap);
    // THE-523 version handshake: warn ONCE per vault on a server↔plugin skew, with the specific
    // incompatibility, instead of letting a route diverge silently. A reachable-but-incompatible
    // companion is the only case that logs; missing/unreachable is bridge STATE, reported elsewhere.
    const compat = checkBridgeCompat(snap);
    if (compat.issues.length > 0) {
      process.stderr.write(`${formatCompatWarning(v.id, compat)}\n`);
    }
  }
  // Per-vault mode resolved once at startup (THE-255): explicit live/headless win; auto uses
  // the companion probe result captured above. Tier-3 bridge tools degrade headless.
  const modeByVault = new Map<string, VaultMode>(
    config.vaults.map((v) => [
      v.id,
      resolveMode(
        { mode: v.mode, restApiUrl: v.restApiUrl },
        capabilities.get(v.id).companion === "reachable",
      ),
    ]),
  );
  // THE-527: re-probe a vault with the SAME config overrides used at startup, so
  // refresh_plugin_capabilities produces a snapshot consistent with a fresh boot. Unknown vault ->
  // an empty (companion-missing) snapshot rather than a throw.
  const vaultConfigById = new Map(config.vaults.map((v) => [v.id, v]));
  const reprobeVault = async (vaultId: string) => {
    const v = vaultConfigById.get(vaultId);
    if (!v) return { companion: "missing" as const, plugins: {} };
    return buildVaultCapabilities(bridgeClients.get(vaultId), {
      probeSkip: v.plugins?.probeSkip,
      forceEnabled: v.plugins?.forceEnabled,
      forceDisabled: v.plugins?.forceDisabled,
      timeoutMs: v.bridges?.probeTimeoutMs,
    });
  };

  const m4Deps: M4Deps = {
    reindex: reindexHook,
    vaultRegistry,
    capabilities,
    bridgeFor: (vaultId) => bridgeClients.get(vaultId),
    timeouts: (vaultId) => timeoutsByVault.get(vaultId) ?? DEFAULT_BRIDGE_TIMEOUTS,
    commandPolicy: (vaultId) => commandsByVault.get(vaultId) ?? { enabled: false, allowlist: [] },
    mode: (vaultId) => modeByVault.get(vaultId) ?? "headless",
    reprobe: reprobeVault,
  };

  registerM2Tools(registry, {
    vaultRegistry,
    embeddingProvider,
    // THE-230: serve-path retrieval logging (experiential.logRetrievals).
    ...(retrievalLog ? { retrievalLog } : {}),
    // THE-406: index_vault must index with the same enrichment as the boot reconcile, or the two
    // paths would re-embed each other's chunks back and forth (the hash covers the enriched text).
    chunkContext: config.embeddings.chunkContext,
    densify: config.retrieval.densify,
    // THE-490/THE-591: index_vault must walk with the same strategy as the boot reconcile
    // (indexing.streamingWalk) — index OUTPUT is identical either way, this only changes memory.
    streamingWalk: config.indexing.streamingWalk,
    // search_dql / search_vault(mode:dql) share the Dataview bridge; openBridge
    // applies the same degradation gate (plugin_missing / plugin_unreachable).
    dataviewBridge: (vaultId) => ({
      client: openBridge(m4Deps, vaultId, "dataview").client,
      timeoutMs: bridgeTimeouts(m4Deps, vaultId).timeoutMs,
    }),
    // THE-293: regex execution budget (worker time only).
    regexTimeoutMs: config.governor.regexTimeoutMs,
    // THE-291 (3B): FTS-accelerated search_text once the boot reconcile's notes pass commits.
    metadataIndex: { hasFts, ready: () => indexHealth.notesReady },
    // THE-491: get_index_status reports chunks_upserted from the last index_vault call.
    // THE-590: this MCP tool path was the one caller of indexVault that never fed the ingest
    // counters / event_log row — add_vault (line ~685) and the boot reconcile (line ~1000) both
    // already call recordIngestStatsFor, so agent-triggered indexing (the normal production path)
    // was invisible to telemetry.
    onIndexVaultComplete: (vaultId, stats) => {
      indexHealth.lastChunksUpserted = stats.chunks_upserted;
      recordIngestStatsFor(vaultId, stats);
    },
  });
  registerM3Tools(registry, {
    vaultRegistry,
    reindex: reindexHook,
    // THE-207: periodic-note creation can expand its template through Templater; openBridge
    // applies the same degradation gate (plugin_missing / requires_live_obsidian).
    templaterBridge: (vaultId) => ({
      client: openBridge(m4Deps, vaultId, "templater").client,
      timeoutMs: bridgeTimeouts(m4Deps, vaultId).templaterTimeoutMs,
    }),
  });
  registerM4Tools(registry, m4Deps);

  // M5 memory/capture substrate (THE-181): capture/memory/workspace are in-process
  // SQLite (+ vault file writes via the M1 path primitives); plur is a global read-only
  // proxy that degrades to plugin_missing when unconfigured. THE-208: config.plur.command routes
  // to the local plur CLI; config.plur.endpoint to an HTTP (Enterprise) read-API.
  const plurClient = createPlurBackend(config.plur);
  registerM5Tools(registry, {
    vaultRegistry,
    activeSessions,
    reindex: reindexHook,
    plur: plurClient,
    bootstrap: config.bootstrap,
    memoryFolder: (vaultId) => memoryFolderByVault.get(vaultId) ?? DEFAULT_MEMORY_FOLDER,
    traceFolder: (vaultId) => traceFolderByVault.get(vaultId) ?? DEFAULT_TRACE_FOLDER,
  });

  // M6 bulk + URI + admin (THE-182): the remaining G2.1 domains (25/27/28), which
  // complete the v1.0 tool surface. One shared RateLimiter (G2.4 tiers from config)
  // is consumed by the bulk tools and snapshotted by get_metrics; the admin tools
  // read non-secret config/ACL/metrics; URI generation is a pure builder.
  const m6Deps: M6Deps = {
    vaultRegistry,
    rateLimiter,
    version: VERSION,
    startedAt,
    authMode: config.auth.mode,
    throttle: config.throttle,
    observability: {
      otel: !!config.observability.otel.endpoint,
      prometheus: config.observability.prometheus.enabled,
      morgiana: config.observability.morgiana.spool || !!config.observability.morgiana.httpEndpoint,
    },
    embeddingsProvider: config.embeddings.provider,
    governorMaxResponseBytes: config.governor.maxResponseBytes,
    capabilities: (vaultId) => capabilities.get(vaultId),
    registeredTools: () => registry.list().length,
  };
  registerM6Tools(registry, { ...m6Deps, reindex: reindexHook, deindex: deindexHook });

  // M7 knowledge domain (THE-233 integration): GraphRAG search (W-RETRIEVAL) + decision
  // red-team (W-WORKERS challenge), wired to the gateway seams (graceful when absent).
  registerM7Tools(registry, {
    vaultRegistry,
    embeddingProvider,
    reranker,
    roles,
    retrieval: config.retrieval,
    ranking: config.ranking,
    // THE-230: serve-path retrieval logging (experiential.logRetrievals).
    ...(retrievalLog ? { retrievalLog } : {}),
    // THE-585: vec0 -> brute-force degradation counter. Unconditional, unlike the config-gated
    // callbacks around it — a silent degradation is exactly the thing you want counted by default.
    onVecFallback,
    onStageMetric,
    // THE-187/193: activation bubble lookup (dark unless experiential.activationRerank).
    ...(activationFor ? { activationFor } : {}),
    // THE-258: class router (dark unless retrieval.classRouter).
    classRouter: config.retrieval.classRouter,
    // THE-132: vault_context's include_work leg reads the experiential store when open.
    ...(experientialOpen ? { edb: experientialDb } : {}),
    // THE-231: same per-vault memory folder as M5 — vault_context's bootstrap mode reads
    // the _next-session.md signal note from it.
    memoryFolder: (vaultId) => memoryFolderByVault.get(vaultId) ?? DEFAULT_MEMORY_FOLDER,
    // THE-136: bootstrap mode reads the prewarm cache (TTL + signal-hash enforced) and
    // writes through on a live compose.
    prewarmDir: config.cacheDir,
    // THE-562 P1.6: reflect.persist writes through the governed path (snapshot + index-on-write).
    snapshots: { enabled: config.snapshots.enabled, retention: config.snapshots.retention },
    reindex: reindexHook,
    // THE-497: the query-product cache (dark unless retrieval.cache.enabled). Built ONCE per
    // process and shared across every dispatch — that is the point, and it is safe because the
    // caller's ACL fingerprint is part of every key rather than of the store's identity.
    ...(config.retrieval.cache.enabled
      ? {
          // THE-507: constructed at the top of this function so the metrics recorder can read its
          // stats; still threaded only under this branch, so the feature gate is unchanged.
          retrievalCaches,
        }
      : {}),
  });

  // M8 experiential domain (THE-229): work-memory retrieval + management verbs over
  // agent_episodes / chunk_retrievals. With the store closed the tools report unavailable.
  registerM8Tools(registry, {
    ...(experientialOpen ? { edb: experientialDb } : {}),
  });

  // THE-295: acl (+ per-vault overrides) is hoisted above the ToolRegistry construction.

  // stdio is the trusted local transport: the operator runs the binary against
  // their own vault, so calls are authenticated with full local scope.
  // THE-514: signal is the SDK's per-request extra.signal, threaded through so a caller that
  // cancels a stdio call stops runDispatch at the next stage boundary.
  const context = (signal?: AbortSignal): CallerContext => {
    const active = activeSessions.get("stdio");
    return {
      caller: "stdio",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: firstVault.id,
      db,
      acl,
      signal,
      ...(active && active.vaultId === firstVault.id ? { sessionId: active.sessionId } : {}),
    };
  };

  const server = createMcpServer({
    name: "obsidian-tc",
    version: VERSION,
    registry,
    context,
    vaultRegistry,
    facadeMode: config.toolFacade.mode,
  });

  if (config.transports.http.enabled) {
    // THE-585 (#11): time the transport's construction + bind. The perf harness measures this as
    // `http.cold_ms` on a synthetic vault; nothing reported it from a real process.
    const httpT0 = performance.now();
    const http = await startHttp({
      name: "obsidian-tc",
      version: VERSION,
      registry,
      vaultRegistry,
      auth: config.auth,
      db,
      vaultId: firstVault.id,
      acl,
      host: config.transports.http.host,
      port: config.transports.http.port,
      facadeMode: config.toolFacade.mode,
      jobQueue,
      enableDnsRebindingProtection: config.transports.http.enableDnsRebindingProtection,
      allowedHosts: config.transports.http.allowedHosts,
      allowedOrigins: config.transports.http.allowedOrigins,
      // THE-520: without this the auth_rejections_total counter exists but is never incremented,
      // so a token refused at the edge stays invisible to /metrics.
      metrics,
    });
    httpConstructSeconds = (performance.now() - httpT0) / 1000;
    process.stderr.write(
      `obsidian-tc http listening on ${config.transports.http.host}:${http.port}\n`,
    );
  }

  if (config.observability.prometheus.enabled) {
    const m = await startMetricsEndpoint({
      recorder: metrics,
      bind: config.observability.prometheus.bind,
      port: config.observability.prometheus.port,
      auth: config.auth,
    });
    process.stderr.write(
      `obsidian-tc /metrics on ${config.observability.prometheus.bind}:${m.port}\n`,
    );
  }

  // Reconcile (THE-255): re-sync the search index with the vault. Incremental (content-hash skip)
  // and best-effort — an embedding-backend or fs hiccup degrades the index, never startup.
  //
  // THE-458 item 6: extracted from the inline boot block so the SAME pass can run on the scheduler.
  // Both reasons to schedule it became true only when THE-649 made the watcher the primary change
  // source: the watcher has blind spots (never started on Windows, can fail to arm on ENOSPC, sees
  // nothing on some network mounts, never covers add_vault vaults), and its single-note writes never
  // densify, so derived edges go stale between full passes. See maintenance.reconcileIntervalMinutes
  // for the operator-facing version. Off unless that key is set.
  const runReconcile = async (): Promise<void> => {
    await Promise.all(
      config.vaults.map((v) =>
        indexVaultRecorded({
          db,
          provider: embeddingProvider,
          embed: embedConfig,
          chunkContext: config.embeddings.chunkContext,
          densify: config.retrieval.densify,
          vaultId: v.id,
          root: vaultRegistry.resolve(v.id).root,
          isReadable: indexReadableFor(v.id),
          now: Date.now,
          sql: sqlHooksFor(v.id),
          onVecRebuild: observability.onVecRebuild,
          onIndexed: makeOnIndexed(v.id),
          // THE-291: metadata/FTS readiness is independent of embed success.
          onNotesPass: () => {
            indexHealth.notesReady = true;
          },
          // THE-490/THE-591: indexing.streamingWalk. Off by default -> byte-identical to before.
          walk: { streaming: config.indexing.streamingWalk },
        }).then(
          // THE-390: a completed reconcile that had to SKIP notes (embed provider rejected a
          // chunk even at single-text size) still degrades health — precise, non-fatal, retried
          // next reconcile — instead of the old behavior of aborting the whole reindex.
          (s) => ({
            vault: v.id,
            error:
              s.notes_embed_failed > 0
                ? `${s.notes_embed_failed} note(s) skipped: embed provider rejected their chunks (HTTP 400)`
                : (null as string | null),
          }),
          (e) => ({ vault: v.id, error: e instanceof Error ? e.message : String(e) }),
        ),
      ),
    ).then(async (results) => {
      applyReconcileOutcome(results, indexHealth, {
        now: Date.now,
        write: (m) => process.stderr.write(m),
      });
      // #14: sweep jobs enqueued during the reconcile through the SAME durable runner as runtime
      // writes, rather than waiting for the scheduler's next CONTRADICTION_DRAIN_MS tick. No-op
      // without the gateway. Fire-and-forget by design; the jobs are durable, so a crash before this
      // runs loses nothing — the next tick or process restart picks them up.
      if (!roles) return;
      await jobRunner.drainOnce(new AbortController().signal);
    });
  };

  // Boot pass: backgrounded so it never blocks stdio, exactly as before.
  void runReconcile();

  morgiana.emit(firstVault.id, "tc.server.start");

  // THE-462: ONE unref'd background scheduler folds the four formerly-independent setInterval
  // timers (maintenance sweep, plane consolidation, activation recompute, contradiction drain) into
  // a single tick loop. Each job keeps its exact run body and error/skip routing; the scheduler adds
  // shared single-flight and durable last-success/next-run (job_schedule in cache.db). Its clock is
  // Date.now for durable timestamps only. Budget deferral is reachable from config
  // (`scheduler.eventLoopDeferMs`, THE-458 item 6) and stays OFF unless an operator sets it.
  const scheduler = new Scheduler({
    now: Date.now,
    db,
    // THE-458 item 6: budget deferral was built, tested, and unreachable — this line is the whole
    // fix. Absent by default, so cadence is unchanged; the monitor is not even created when unset.
    ...(config.scheduler.eventLoopDeferMs !== undefined
      ? { eventLoopDeferMs: config.scheduler.eventLoopDeferMs }
      : {}),
  });
  // THE-466 slice 2: hand the live scheduler to the observability module's lazy gauge sources
  // (schedulerSkipped / schedulerConsecutiveFailures / schedulerDeferred).
  schedulerRef = scheduler;

  // THE-292: periodic cache.db maintenance. THE-466 slice 3 moved the wiring to
  // ./runtime/maintenance-wiring.ts, where the sweep's reporting (which has drifted twice as arms
  // were added) is unit-testable instead of buried in this boot function.
  configureMaintenance(scheduler, {
    db,
    maintenance: config.maintenance,
    retention: config.observability.retention,
    vaults: config.vaults,
    defaultTraceFolder: DEFAULT_TRACE_FOLDER,
    // THE-610 arm 2: only when the membrane is actually open — cli.ts closes the handle otherwise.
    ...(experientialOpen ? { edb: experientialDb } : {}),
    morgiana,
    eventVaultId: firstVault.id,
  });

  // THE-296 / #14: ambient sleep-time consolidation (weekly synthesis + daily audit) is now durable
  // jobs — a transient gateway failure retries/dead-letters instead of vanishing (the old
  // in-process plane timer ran with no persistence; its registerPlaneScheduler was deleted as dead
  // code in THE-458 — nothing had referenced it since #14). Registered only
  // when BOTH the flag and the gateway roles are present: the generative jobs degrade without roles,
  // but scheduling them then is pure DB churn. Idempotency keys (per iso-week / per-day) keep a slow
  // run from piling up duplicate jobs; the job-queue-runner (registered above) executes them.
  if (config.plane.enabled && roles) {
    scheduler.register({
      name: "plane-enqueue",
      intervalMs: config.plane.intervalMinutes * 60_000,
      run: () => {
        const iso = isoWeek(new Date());
        jobQueue.enqueue("synthesis", {
          class: "plane",
          idempotencyKey: `synthesis:${iso.year}-${iso.week}`,
          maxAttempts: 1,
        });
        const day = new Date().toISOString().slice(0, 10);
        jobQueue.enqueue("audit", {
          class: "plane",
          idempotencyKey: `audit:${day}`,
          maxAttempts: 1,
        });
      },
      onError: (e) =>
        process.stderr.write(
          `[plane-enqueue] enqueue failed: ${e instanceof Error ? e.message : String(e)}\n`,
        ),
    });
  }

  // THE-227/228: keep cached_activation_score warm as capture accrues. recomputeActivation is
  // otherwise CLI-only, so on serve the activation state would freeze at whatever a manual run
  // left, stale the moment new retrievals land. Registered only while the experiential store is open
  // (capture on); idempotent, no gateway, best-effort. Reuses the maintenance cadence.
  if (experientialOpen) {
    wireActivationRecompute(scheduler, observability, {
      edb: experientialDb,
      intervalMs: config.maintenance.intervalMinutes * 60_000,
    });
  }

  // #14: the durable job-queue runner, folded into the unified scheduler exactly as the old
  // contradiction-drain worker was — claim/lease/retry/dead-letter all live in JobQueue itself, so
  // this registration only needs to tick. Registered only when the gateway is configured (no
  // handlers are registered without roles, so an unconditional registration would just dead-letter
  // every claimed job — see makeJobRunner's empty-handlers guard).
  if (roles) {
    scheduler.register({
      name: "job-queue-runner",
      intervalMs: CONTRADICTION_DRAIN_MS,
      run: (signal) => jobRunner.drainOnce(signal),
    });
  }

  // THE-458 item 6: the periodic reconcile. The scheduler's single-flight guard matters more here
  // than for any other job — a reconcile walks the whole vault and can outlast its own interval, and
  // overlapping passes would compete for the same write lock rather than finishing sooner.
  if (config.maintenance.reconcileIntervalMinutes !== undefined) {
    scheduler.register({
      name: "vault-reconcile",
      intervalMs: config.maintenance.reconcileIntervalMinutes * 60_000,
      run: () => runReconcile(),
    });
  }

  scheduler.start();

  const shutdown = async (): Promise<void> => {
    // THE-649: stop watching BEFORE draining. A late filesystem event would otherwise enqueue new
    // coordinator work while indexCoordinator.idle() below is waiting for the queue to empty.
    stopVaultWatch();
    // THE-462: one bounded stop replaces the four stop functions — clears the timer, aborts the
    // in-flight run's AbortSignal, and awaits settle under the scheduler's deadline.
    await scheduler.stop();
    morgiana.emit(firstVault.id, "tc.server.shutdown");
    // THE-457: drain in-flight work under a bounded deadline before exit, so a write mid-index isn't
    // lost and SQLite closes cleanly. Never hang — race the drain against a timeout.
    await Promise.race([
      (async () => {
        await indexCoordinator.idle().catch(() => {});
        // #14: no explicit contradiction drain here any more — durable jobs survive the process
        // exiting mid-lease (claim()'s lease-expiry reclaim picks them up, here or in the next
        // process), so there is nothing that would be LOST by skipping a final drain. One bounded
        // best-effort pass still gives a live worker a chance to clear the queue before exit rather
        // than always waiting out the lease.
        const shutdownDrain = new AbortController();
        setTimeout(() => shutdownDrain.abort(), SHUTDOWN_DRAIN_MS).unref();
        // If the outer Promise.race's own SHUTDOWN_DRAIN_MS timeout wins first, a handler already
        // mid-write here is abandoned in place — safe, because the job row is still 'running' with
        // a lease that will expire; claim()'s reclaim picks it back up next tick or next process,
        // never silently lost.
        await jobRunner.drainOnce(shutdownDrain.signal).catch(() => {});
      })(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, SHUTDOWN_DRAIN_MS).unref();
      }),
    ]);
    try {
      await otel.shutdown();
    } catch {
      /* shutdown is best-effort */
    }
    try {
      db.close?.();
    } catch {
      /* best-effort: closing the cache DB on the way out */
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Security posture summary (audit #268 P1): make the active profile obvious at startup, and warn
  // when the permissive trusted-local defaults are active — governed by default is not least-privilege
  // by default. stderr only (the stdio MCP protocol owns stdout).
  {
    const rootAcl = config.acl;
    // THE-526: name the active profile so it is a stated fact, not something inferred from six fields.
    const profile = config.securityProfile ?? "trusted-local";
    process.stderr.write(
      `security: profile=${profile} auth=${config.auth.mode} readOnly=${rootAcl.readOnly} strictRead=${rootAcl.strictReadDefault} requireCas=${config.writes.requireCas} http=${config.transports.http.enabled ? "on" : "off"}\n`,
    );
    if (
      config.auth.mode === "none" &&
      !rootAcl.readOnly &&
      !rootAcl.strictReadDefault &&
      !config.writes.requireCas
    ) {
      process.stderr.write(
        "security: running with trusted-local defaults (auth=none, no strict-read, no CAS). For a " +
          'shared or multi-caller deployment set securityProfile: "hardened" (strictReadDefault, ' +
          "requireCas, snapshots, HTTP off) plus your read/write paths, or copy " +
          "examples/config.hardened.json.\n",
      );
    }
  }

  // THE-288: honor transports.stdio. Default (true) connects the stdio MCP transport; when false
  // the server serves HTTP-only (the listening socket keeps the process alive), and if neither
  // transport is enabled there is nothing to serve, so exit with a clear message.
  if (config.transports.stdio) {
    await connectStdio(server);
    process.stderr.write(
      `obsidian-tc ${VERSION} ready on stdio (vault ${firstVault.id}; native=${nativeLoaded ? "on" : "off"} vec=${hasVec ? "on" : "off"})\n`,
    );
  } else if (config.transports.http.enabled) {
    process.stderr.write(
      `obsidian-tc ${VERSION} ready (http-only; stdio disabled; vault ${firstVault.id}; native=${nativeLoaded ? "on" : "off"} vec=${hasVec ? "on" : "off"})\n`,
    );
  } else {
    process.stderr.write(
      "obsidian-tc: no transport enabled (transports.stdio=false and transports.http.enabled=false); nothing to serve\n",
    );
    process.exit(1);
  }
}

// THE-605 audit classification of every one-shot CLI command dispatched below (verified against
// this exact switch, not re-derived from a grep): 7 are read-only/display (version, help, error,
// plugin-install, config-show/-validate, config-explain, doctor) — nothing to audit. ~9 recompute
// DERIVED state (cluster, activation-recompute, densify-llm, citation-infer, contribution-report,
// note-quality, gaps, metrics, reflect) — real writes, but of RECOMPUTABLE state: a re-run
// reproduces it, so an audit row would be noise (a rewritten cluster assignment is not a loss
// event). `prefetch` dispatches properly through `registry.dispatch` and gets an audit row for
// free. `forget` is the ONE command with true vault-destructive writes (writeNoteAtomic-adjacent
// erase/unlink), and is the only one that writes `audit_events` directly (cli/commands/forget.ts,
// `auditForgetEvent`) — see that file for the writer and the "why not runDispatch" reasoning. This
// is a DECISION, not an oversight: do not add audit rows to the recompute commands above without
// re-litigating the "recomputable state is not a loss event" premise this classification rests on.
async function main(): Promise<void> {
  const cmd = parseCliArgs(process.argv.slice(2));
  switch (cmd.kind) {
    case "token-mint":
      return run_token_mint(cmd);
    case "version":
      return run_version(cmd);
    case "help":
      return run_help(cmd);
    case "error":
      return run_error(cmd);
    case "plugin-install":
      return run_plugin_install(cmd);
    case "config-show":
    case "config-validate":
      return run_config_show(cmd);
    case "config-explain":
      return run_config_explain(cmd);
    case "doctor":
      return run_doctor(cmd);
    case "cluster":
      return run_cluster(cmd);
    case "activation-recompute":
      return run_activation_recompute(cmd);
    case "densify-llm":
      return run_densify_llm(cmd);
    case "citation-infer":
      return run_citation_infer(cmd);
    case "contribution-report":
      return run_contribution_report(cmd);
    case "note-quality":
      return run_note_quality(cmd);
    case "forget":
      return run_forget(cmd);
    case "gaps":
      return run_gaps(cmd);
    case "metrics":
      return run_metrics(cmd);
    case "reflect":
      return run_reflect(cmd);
    case "prefetch":
      return run_prefetch(cmd);
    default:
      return run_serve(cmd);
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
