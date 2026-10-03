// `buildServerRuntime` is the composition root (stores -> otel/observability -> wireRuntimeCore ->
// job queue/health tools -> gateway seams -> job handlers -> index coordinator/watcher -> M1 ->
// bridge clients/capability snapshots -> M2-M8 -> MCP server -> transports -> scheduler), argv-free,
// returning a `ServerRuntime` whose `start()` fires the boot reconcile/scheduler/stdio and whose
// `close(reason)` is the ordered, idempotent shutdown.
// `stores` (and `otel`) are constructed OUTSIDE `wireRuntimeCore` and handed in as params, then
// folded into its own unwind stack, because real boot's construction order requires them to sit
// textually between `stores` and `governance` — reordering that is forbidden, and accepting an
// arbitrary deps callback would reintroduce the service-locator this file avoids (docs/design/server-runtime.md).

import { fstatSync } from "node:fs";
import { dirname } from "node:path";
import {
  isFeedbackExemptFromReadOnly,
  type ServerConfig,
} from "@the-40-thieves/obsidian-tc-shared";
import { version as VERSION } from "../../package.json";
import { experientialMigrations } from "../cli/shared";
import { createStdioElicitCodec } from "../elicit";
import { buildMemoryDefenseLookup } from "../experiential/memory-defense";
import { healthToolsWiringFields, mcpServerFacadeOptions } from "../mcp/facade-auto";
import type { CallerContext, ToolRegistry } from "../mcp/registry";
import { createMcpServer } from "../mcp/server";
import { disabledByProfileFor } from "../mcp/tool-profiles";
import { ALLOW_ALL } from "../mcp/visibility";
import { initOtel } from "../otel/tracing";
import { compileEgressFilter, isExcludedPath } from "../plane/egress-filter";
import { resolveHostId } from "../provenance/recorder";
import type { Scheduler } from "../scheduler/scheduler";
import type { IndexCoordinator } from "../search/index-coordinator";
import { vaultExclusionFor } from "../search/index-exclusion";
import { wireLeaderEpoch } from "../search/indexing/leader-epoch";
import { nativeBindingActive } from "../search/native";
import { createRetrievalCaches } from "../search/query_cache";
import { wireTelemetry } from "../telemetry/wiring";
import { connectStdio } from "../transports/stdio";
import { nativeReadyToken, type OwnedLayer, requireBoot, unwindReversed } from "./boot-helpers";
import { emitBootNotices } from "./boot-notices";
import { wireBridges } from "./bridge-wiring";
import { createExclusionReloader } from "./exclusion-reload";
import { wireIndexCoordinator } from "./indexing-wiring";
import { createObservability } from "./observability";
import {
  createJobQueue,
  createOnIndexedHook,
  createReconcileRunner,
  wireJobHandlers,
} from "./plane-wiring";
import { wireRuntimeCore } from "./runtime-core-wiring";
import { wireScheduler } from "./scheduler-wiring";
import { makeSandboxRerun } from "./session-rerun-sandbox";
import { joinReconcileOrExit, logShutdownError, raceShutdownPhaseOrExit } from "./shutdown-phase";
import { wireStoresBehindBootstrapBarrier } from "./stores";
import { wireDomainTools, wireGatewaySeams, wireHealthTools, wireM1Tools } from "./tool-wiring";
import { wireTransports } from "./transport-wiring";
import { type GatedReconcile, gateReconcileByLeader, startVaultLeaderElection } from "./vault-lock";

/** Public runtime surface: `registry` is what every caller of a fully-composed runtime needs;
 *  `start`/`close` are the only lifecycle verbs. No other runtime state is exposed. */
export interface ServerRuntime {
  registry: ToolRegistry;
  start(): Promise<void>;
  close(reason: string): Promise<void>;
}

// requireBoot/nativeReadyToken/OwnedLayer/unwindReversed moved to boot-helpers.ts (biome's 700-line
// cap) — imported above, see server-runtime.test.ts for their own import path.

// RuntimeCoreDeps/RuntimeCore (wireRuntimeCore's input/output contract) moved to
// runtime-core-types.ts, and wireRuntimeCore itself to runtime-core-wiring.ts, same 700-line cap —
// re-exported so every existing import path (including wireRuntimeCore's own test suite) keeps
// working.
export type { RuntimeCore, RuntimeCoreDeps } from "./runtime-core-types";
export { wireRuntimeCore };

// THE-457: cap on how long graceful shutdown waits for in-flight index work.
const SHUTDOWN_DRAIN_MS = 5000;

/**
 * The full composition root. Builds every boot resource in the same order as inline boot — stores,
 * otel/observability, governance+index resources (`wireRuntimeCore`), job queue, health tools,
 * gateway seams, job handlers/runner, index coordinator+watcher, M1, bridge clients/capability
 * snapshots, M2-M8, MCP server, transports, scheduler (registered, not started) — then returns a
 * `ServerRuntime` whose `start()` is the go-live step and whose `close(reason)` is the ordered,
 * idempotent shutdown. Argv-free: takes an already-resolved `ServerConfig`, never touches
 * `process.argv`. See docs/design/server-runtime.md.
 */
export async function buildServerRuntime(
  config: ServerConfig,
  configPath: string | undefined,
  /** Test-only: fires with each already-built layer's name, in the order its cleanup ran, on either
   *  failure window this function covers. Never invoked on the happy path, never passed by
   *  production callers (cli.ts). */
  onCleanup?: (name: string) => void,
  /** THE-825: whether the raw config file explicitly set `plane.enabled`. Governs `start()`'s
   *  boot-time opt-in notice (plane-opt-in-notice.ts). Defaults `true` so non-`run_serve` callers
   *  never nag by accident; cli.ts's `run_serve` passes the real computed value. */
  planeEnabledExplicit = true,
): Promise<ServerRuntime> {
  const firstVault = config.vaults[0];
  if (!firstVault) throw new Error("config.vaults must contain at least one vault");
  // Trust root for a `module` provider's modulePath: cwd in a container is arbitrary, so a
  // relative modulePath resolves against the config FILE's directory instead, refused entirely
  // when `configPath` is absent (module-loader.ts; see docs/design/server-runtime.md).
  const configDir = configPath !== undefined ? dirname(configPath) : undefined;
  const startedAt = Date.now();
  // THE-934 fix round 1: computed FIRST (not beside wireGatewaySeams, round 0's placement) --
  // wireRuntimeCore below constructs the embedding provider PORT (wireIndexResources ->
  // createEmbeddingProviderAsync), which must be guarded before ANY consumer (indexVault,
  // indexNote, the query encoder, the advisory sweep) can reach it. One predicate for every vault
  // (unlike indexReadableFor, egress.excludePaths is global, not per-vault-ACL).
  const egressFilter = compileEgressFilter(config.egress.excludePaths);
  const isEgressExcluded = (rel: string): boolean => isExcludedPath(egressFilter, rel);

  // GH #995 (COLD_BOOT_PRELOCK): serializes migrations across racing processes on a fresh boot — see wireStoresBehindBootstrapBarrier's doc comment.
  const stores = await wireStoresBehindBootstrapBarrier({
    cacheDir: config.cacheDir,
    version: VERSION,
    busyTimeoutMs: config.db.busyTimeoutMs, // THE-935: reaches every connectionPragmas() call site via wireStores -> openDatabase / provisionExperientialDb
    experiential: config.experiential,
    experientialMigrations,
    // Stable vault identity (20260928_001): the SAME config.vaults governance/sticky-provider
    // resolution reads (line ~284/~178 below) — a rename must be resolved against the exact ids
    // this boot registers, same reasoning as GH #995 fix round 2's sticky-embeddings vaults wiring.
    vaults: config.vaults.map((v) => ({ id: v.id, path: v.path })),
  });
  const { db, experientialDb, retrievalLog, activationFor, experientialOpen } = stores;

  // Prometheus recorder (G2.4) — always live so get_metrics and the optional /metrics scrape
  // share the same in-memory counters. OTEL tracing — no-op unless observability.otel.endpoint set.
  const otel = await initOtel(config.observability, VERSION);
  // THE-507: hoisted ABOVE the recorder so its stats can be a gauge source.
  const retrievalCaches = createRetrievalCaches({
    maxEntries: config.retrieval.cache.maxEntries,
    ttlMs: config.retrieval.cache.ttlSeconds * 1000,
  });
  // THE-585 (#11): set once, when the HTTP transport is constructed, below.
  let httpConstructSeconds: number | null = null;
  // indexCoordinator/scheduler are built further down; these lazy refs let readers see them live.
  let indexCoordinatorRef: IndexCoordinator | undefined;
  let schedulerRef: Scheduler | undefined;
  let toolRegistryRef: ToolRegistry | undefined; // grok HIGH-1: registry built after telemetry.
  const getKnownToolNames = () => new Set(toolRegistryRef?.list().map((t) => t.name) ?? []);
  const telemetry = wireTelemetry({ config, db, serverVersion: VERSION, getKnownToolNames }); // THE-1125
  const observability = createObservability({
    db,
    cacheDir: config.cacheDir,
    morgianaSpool: config.observability.morgiana.spool,
    retrievalCaches,
    getIndexCoordinatorStats: () => requireBoot(indexCoordinatorRef, "indexCoordinator").stats(),
    getSchedulerStats: () => requireBoot(schedulerRef, "scheduler").stats(),
    getHttpConstructSeconds: () => httpConstructSeconds,
    toolCallObserver: telemetry.observer,
  });
  const {
    metrics,
    onVecFallback,
    onStageMetric,
    onRerankOutcome,
    sqlHooksFor,
    morgiana,
    onSnapshotSkipped,
  } = observability;

  const { governance, indexResources } = await wireRuntimeCore({
    stores,
    cacheDir: config.cacheDir,
    traceContent: config.sessions.traceContent,
    vaults: config.vaults,
    acl: config.acl,
    defaultVaultId: process.env.OBSIDIAN_TC_DEFAULT_VAULT,
    elicitTtlSeconds: config.elicitTtlSeconds,
    throttle: config.throttle,
    busyTimeoutMs: config.db.busyTimeoutMs,
    maxResponseBytes: config.governor.maxResponseBytes,
    idempotencyTtlSeconds: config.idempotencyTtlSeconds,
    idempotencyReclaimSeconds: config.idempotencyReclaimSeconds,
    toolVisibility: {
      ...(config.toolVisibility ?? ALLOW_ALL),
      allowReadOnlyDerivedTelemetry: isFeedbackExemptFromReadOnly(config.experiential),
      disabledByProfile: disabledByProfileFor(config.toolFacade.profile),
    },
    metrics,
    tracer: otel.tracer,
    otelDetail: config.observability.otel.detail,
    morgiana,
    // otel is opened just above, between `stores` and this call — handing it in folds its shutdown
    // into wireRuntimeCore's own unwind if governance or index resources throws (`onCleanup` fires
    // only when wireRuntimeCore itself throws — a distinct window from postCoreLayers below).
    otel,
    onCleanup,
    embeddings: config.embeddings,
    onVecRebuild: observability.onVecRebuild,
    configDir,
    securityProfile: config.securityProfile,
    excludeFilter: egressFilter,
    ...(config.provenance.enabled
      ? {
          provenance: {
            host: resolveHostId(config.provenance.host),
            serverVersion: VERSION,
            hooks: sqlHooksFor("provenance"),
            stamp: config.provenance.stamp,
          },
        }
      : {}),
  });
  const { acl, aclByVault, vaultRegistry, activeSessions, rateLimiter, registry } = governance;
  toolRegistryRef = registry; // THE-1125: registry exists now — see this file's lazy-ref comment above.
  const {
    embeddingProvider,
    embedConfig,
    hasVec,
    hasFts,
    indexHealth,
    recordIngestStatsFor,
    indexVaultRecorded,
    // GH #995 fix round 2 (item B): computed INSIDE wireIndexResources now (via wireRuntimeCore),
    // not by this function itself — see that function's doc comment. Still read here, unchanged,
    // for the boot notice below.
    embeddingsSticky,
  } = indexResources;

  // A later construction failure (e.g. wireTransports below) must still close what this function
  // went on to open after `wireRuntimeCore` succeeded: the vault watcher and any transport socket,
  // then governance and stores, in reverse order via `unwindReversed`. `indexResources` contributes
  // no cleanup of its own, so it is not repeated here.
  const postCoreLayers: OwnedLayer[] = [
    { name: "stores", close: stores.close },
    { name: "governance", close: governance.close },
  ];
  // requireBoot idiom (see this file's top): assigned once at the end of the try block, after
  // every post-core step succeeds; the catch below always rethrows.
  let postCore:
    | {
        runReconcile: GatedReconcile;
        scheduler: Scheduler;
        server: ReturnType<typeof createMcpServer>;
        transports: Awaited<ReturnType<typeof wireTransports>>;
        indexCoordinator: IndexCoordinator;
        stopVaultWatch: () => void;
        jobRunner: Awaited<ReturnType<typeof wireJobHandlers>>["jobRunner"];
      }
    | undefined;
  // THE-825: gateway resolved (roles !== null)? Read by start()'s plane opt-in boot notice.
  let gatewayConfigured = false;
  const bootReconcileAbort = new AbortController(); // GH #995: shared with the leader election's onPromote
  let leaderElection!: Awaited<ReturnType<typeof startVaultLeaderElection>>; // GH #995: hoisted for close()

  try {
    leaderElection = await startVaultLeaderElection({
      cacheDir: config.cacheDir, // GH #995 (vault-lock.ts)
      pid: process.pid,
      version: VERSION,
    });
    postCoreLayers.push({ name: "leaderElection", close: () => leaderElection.close() });
    const currentLeaderEpoch = wireLeaderEpoch(leaderElection, db); // GH #995: see leader-epoch.ts
    // #14: durable contradiction jobs. Constructed here (ahead of its natural "plane" home) so
    // server_health's getJobQueueStats accessor below can close over it.
    const jobQueue = createJobQueue(db, sqlHooksFor);

    // server_health / get_index_status: NOT in boot.tools_registered (tool-wiring.ts header comment).
    wireHealthTools({
      registry,
      version: VERSION,
      ...healthToolsWiringFields(config, telemetry, db), // THE-1108: db -> getStaleExplicitSessions.
      startedAt,
      hasVec,
      hasFts,
      indexHealth,
      getIndexCoordinatorStats: () => requireBoot(indexCoordinatorRef, "indexCoordinator").stats(),
      getJobQueueStats: () => jobQueue.stats(),
      getLeaderRole: () => (leaderElection.isLeader() ? "leader" : "follower"), // GH #995
      getLeaderRoleDetail: () => leaderElection.getLastFollowerError(),
    });

    const { reranker, roles } = await wireGatewaySeams(
      config.embeddings,
      config.reranker,
      configDir,
      config.securityProfile,
      config.gateway,
      egressFilter,
    );
    gatewayConfigured = roles !== null;

    // W-INGEST onIndexed hook -> contradiction enqueue; THE-822: plane.enabled also gates this.
    const makeOnIndexed = createOnIndexedHook({ jobQueue, roles, plane: config.plane });

    const { jobRunner } = wireJobHandlers({
      registry,
      db,
      acl,
      jobQueue,
      roles,
      plane: config.plane,
      embeddingProvider,
      experientialOpen,
      experientialDb,
      vaults: config.vaults,
      maxPromptChars: config.plane.maxPromptChars,
      gatewayMaxAttempts: config.plane.gatewayMaxAttempts,
      gatewayTimeoutMs: config.plane.gatewayTimeoutMs,
      egressExcludePaths: config.egress.excludePaths, // THE-934
      // THE-717: citation pass needs the AUTHORED store + a query-side embedder, unlike other plane
      // jobs. Passed unconditionally; wireJobHandlers decides whether to register anything.
      citationInfer: config.experiential.citationInfer,
      cacheDb: db,
      embed: (texts) => embeddingProvider.embed(texts, { input: "query" }),
    });

    // Obsidian's Excluded files: a changed `.obsidian/app.json` (reported by the watcher) reconciles.
    const exclusionReload = createExclusionReloader(vaultRegistry, bootReconcileAbort.signal);
    // THE-291 (part 2)/THE-455/THE-453/THE-649: the coordinator, the reindex/deindex hooks, and the
    // vault watcher.
    const { indexCoordinator, indexReadableFor, reindexHook, deindexHook, stopVaultWatch } =
      wireIndexCoordinator({
        db,
        metrics,
        embeddingProvider,
        hasVec,
        chunkContext: config.embeddings.chunkContext,
        chunkTokens: config.indexing.chunkTokens, // THE-424
        indexing: config.indexing,
        // THE-1081 review round (Medium 1): the CANONICAL root (vaultRegistry.list(), realpath'd
        // at registration — see vault/registry.ts), not raw `config.vaults`. registerVaultWatch
        // (vault/watcher.ts) stores this string verbatim and re-opens it on every flush; a raw
        // config path reached through a symlinked ancestor (e.g. macOS $TMPDIR) made the native
        // addon refuse that open and deindex the note the watcher had just seen written.
        vaults: vaultRegistry.list().map((v) => ({ id: v.id, path: v.root })),
        watch: config.watch,
        sqlHooksFor,
        indexHealth,
        acl,
        aclByVault,
        makeOnIndexed,
        isEgressExcluded, // THE-934 fix round 1 (Blocking-1)
        indexExclusionFor: (id) => vaultExclusionFor(vaultRegistry, id),
        onVaultConfigChange: (id) => void exclusionReload.onVaultConfigChange(id),
        isLeader: leaderElection.isLeader, // GH #995
        onDemote: leaderElection.onDemote,
      });
    // THE-466 slice 2: hand the live coordinator to the observability module's lazy gauge sources.
    indexCoordinatorRef = indexCoordinator;
    // THE-649: pushed immediately (first layer after wireRuntimeCore) so a later throw stops it too.
    postCoreLayers.push({ name: "watcher", close: () => stopVaultWatch() });

    // GH #994 follow-up: M1's memoryDefense guard — M1 wires before wireBridges builds its own map.
    const memoryDefenseForM1 = buildMemoryDefenseLookup(config.vaults);

    wireM1Tools({
      registry,
      config,
      representation: indexResources.representation,
      version: VERSION,
      startedAt,
      configPath,
      vaultRegistry,
      db,
      embeddingProvider,
      embedConfig,
      hasFts,
      indexHealth,
      onSnapshotSkipped,
      reindex: reindexHook,
      deindex: deindexHook,
      indexReadableFor,
      isEgressExcluded, // THE-934
      sqlHooksFor,
      onVecRebuild: observability.onVecRebuild,
      makeOnIndexed,
      indexVaultRecorded,
      experientialOpen,
      experientialDb,
      memoryDefense: memoryDefenseForM1,
      metrics,
      provenanceStamp: governance.provenanceStamp,
      ...(governance.provenance ? { provenance: governance.provenance } : {}),
    });

    // M4 plugin bridges (THE-180): per-vault client + probed capability snapshot, built before M2 so search_dql can share the same Dataview bridge.
    const bridges = await wireBridges({
      vaults: config.vaults,
      vaultRegistry,
      reindex: reindexHook,
      metrics,
    });

    // `session_rerun` (m6/admin-tools.ts) — build a SECOND, disposable runtime scoped to a staged
    // copy of one session's own vault, run its re-issue there, then dispose it. Extracted to
    // session-rerun-sandbox.ts (biome's 700-line noExcessiveLinesPerFile cap); `buildServerRuntime`
    // is passed in BY REFERENCE rather than imported there, so nothing downstream of
    // `wireDomainTools` needs to import this file at all — see that module's own doc comment.
    const runSandboxSessionRerun = makeSandboxRerun(config, configPath, buildServerRuntime);

    wireDomainTools({
      registry,
      config,
      vaultRegistry,
      embeddingProvider,
      representation: indexResources.representation,
      ...(retrievalLog ? { retrievalLog } : {}),
      m4Deps: bridges.m4Deps,
      hasFts,
      indexHealth,
      recordIngestStatsFor,
      reindex: reindexHook,
      deindex: deindexHook,
      activeSessions,
      memoryFolderByVault: bridges.memoryFolderByVault,
      traceFolderByVault: bridges.traceFolderByVault,
      memoryDefenseByVault: bridges.memoryDefenseByVault,
      reflectDefaultsByVault: bridges.reflectDefaultsByVault,
      metrics,
      rateLimiter,
      version: VERSION,
      startedAt,
      capabilities: bridges.capabilities,
      reranker,
      roles,
      retrievalCaches,
      onVecFallback,
      onStageMetric,
      onRerankOutcome,
      onAclWalkPruned: observability.onAclWalkPruned, // THE-891 item 3
      ...(activationFor ? { activationFor } : {}),
      experientialOpen,
      experientialDb,
      sandboxRerun: runSandboxSessionRerun,
      provenanceStamp: governance.provenanceStamp,
    });

    /** stdio is the trusted local transport: the operator runs the binary against their own vault,
     *  so calls are authenticated with full local scope. THE-514: signal is the SDK's per-request
     *  extra.signal, threaded through so a caller that cancels a stdio call stops runDispatch at
     *  the next stage boundary. */
    const context = (signal?: AbortSignal): CallerContext => {
      const active = activeSessions.validate(db, "stdio", config.sessions);
      return {
        caller: "stdio",
        transport: "stdio",
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
      // THE-937 round 3: stdio's own visibility, no `context()` call — see the field's doc
      // comment. Stdio's is a fixed literal (never varies), so no readOnly/toolVisibility gap.
      visibility: { grantedScopes: new Set(["*"]), readOnly: acl?.readOnly },
      vaultRegistry,
      ...mcpServerFacadeOptions(config.toolFacade),
      // GH #1027: resources/read takes no parameters, so the config default is its only selector.
      responseFormat: config.tools?.defaults?.responseFormat,
      // THE-1098 (GH #964): suppresses buildInstructions' record_retrieval_feedback clause when
      // there are no retrieval rows for feedback to update.
      experientialLogRetrievals: config.experiential.logRetrievals,
      elicitCodec: createStdioElicitCodec(), // THE-1106: see its doc comment (elicit.ts)
      legacyElicitationShim: true,
    });

    const transports = await wireTransports({
      config,
      version: VERSION,
      registry,
      vaultRegistry,
      db,
      firstVaultId: firstVault.id,
      acl,
      jobQueue,
      metrics,
      provenance: governance.provenance,
    });
    httpConstructSeconds = transports.httpConstructSeconds;
    postCoreLayers.push({ name: "transports", close: () => transports.close() });

    // THE-458 item 6: re-sync the search index with the vault, both at boot (fire-and-forget, see
    // start() below) and on the scheduler.
    const runReconcileRaw = createReconcileRunner({
      vaults: config.vaults,
      db,
      embeddingProvider,
      embedConfig,
      chunkContext: config.embeddings.chunkContext,
      chunkTokens: config.indexing.chunkTokens, // THE-424
      representation: indexResources.representation,
      densify: config.retrieval.densify,
      vaultRegistry,
      indexReadableFor,
      isEgressExcluded, // THE-934
      sqlHooksFor,
      onVecRebuild: observability.onVecRebuild,
      makeOnIndexed,
      indexHealth,
      streamingWalk: config.indexing.streamingWalk,
      backgroundEmbed: config.indexing.backgroundEmbed, // GH #995 follow-up; renamed fix round (Codex review)
      indexVaultRecorded,
      roles,
      jobRunner,
      leaderEpoch: currentLeaderEpoch, // GH #995 follow-up
    });
    const runReconcile = gateReconcileByLeader(leaderElection, runReconcileRaw, bootReconcileAbort); // GH #995
    exclusionReload.setRunner(runReconcile);

    const scheduler = wireScheduler({
      config,
      db,
      // THE-1081 review round 2 (Medium 1): the CANONICAL root, under `root` (the field
      // resolveTraceDirs requires by name) — previously the RAW config path, which threw
      // vault_not_found at boot for a vault root that is itself a symlink (iCloud/Dropbox/NAS
      // sync targets; see vault/watcher.ts), with maintenance.enabled defaulting to true.
      vaults: config.vaults.map((v) => ({
        id: v.id,
        root: vaultRegistry.resolve(v.id).root,
        ...(v.workspace !== undefined ? { workspace: v.workspace } : {}),
        wikiFolder: vaultRegistry.resolve(v.id).wikiFolder,
        rawFolders: vaultRegistry.resolve(v.id).rawFolders,
      })),
      eventVaultId: firstVault.id,
      listVaultIds: () => vaultRegistry.list().map((v) => v.id),
      ...(transports.authRegistry ? { authRegistry: transports.authRegistry } : {}),
      ...(governance.provenance ? { provenance: governance.provenance } : {}),
      experientialOpen,
      experientialDb,
      observability,
      morgiana,
      roles,
      jobQueue,
      jobRunner,
      runReconcile,
      embeddingProvider,
      // The scheduled wiki lint leaves Excluded-files notes out of every proposal, as lint_wiki does.
      exclusionFor: (id) => vaultExclusionFor(vaultRegistry, id),
      // The scheduled index.md / log.md regeneration writes under the vault's own ACL and policy.
      aclFor: (id) => registry.aclFor(id),
      memoryDefenseFor: memoryDefenseForM1,
      ...(transports.advisoryBus ? { advisoryBus: transports.advisoryBus } : {}), // THE-634
      telemetry, // THE-1125
      activeSessions, // THE-1108 fix
    });
    // THE-466 slice 2: hand the live scheduler to the observability module's lazy gauge sources.
    schedulerRef = scheduler;

    postCore = {
      runReconcile,
      scheduler,
      server,
      transports,
      indexCoordinator,
      stopVaultWatch,
      jobRunner,
    };
  } catch (err) {
    await unwindReversed(postCoreLayers, onCleanup);
    throw err;
  }
  const {
    runReconcile,
    scheduler,
    server,
    transports,
    indexCoordinator,
    stopVaultWatch,
    jobRunner,
  } = requireBoot(postCore, "postCore");

  let closed = false;
  const start = async (): Promise<void> => {
    void runReconcile(bootReconcileAbort.signal); // Boot pass, backgrounded; leader-gated (GH #995)

    morgiana.emit(firstVault.id, "tc.server.start");

    scheduler.start();

    // Security posture, THE-825 plane opt-in, THE-891 capture, THE-1108 stale-session notices —
    // folded into one call; see boot-notices.ts's header for why they moved out of here.
    emitBootNotices({
      config,
      gatewayConfigured,
      planeEnabledExplicit,
      db,
      embeddingsSticky,
    });

    // THE-288: honor transports.stdio. Default (true) connects the stdio MCP transport; when
    // false the server serves HTTP-only (the listening socket keeps the process alive), and if
    // neither transport is enabled there is nothing to serve, so exit with a clear message.
    if (config.transports.stdio) {
      // A headless deploy with HTTP also enabled (docker/systemd, stdin backed by /dev/null) hits
      // stdio EOF the instant it starts — the notice below fires BEFORE that happens, so it reads
      // as an explanation rather than a post-mortem. Best-effort: an fd-0 stat failing (already
      // closed, or a platform that refuses it) just means no notice, never a startup error.
      if (config.transports.http.enabled) {
        try {
          const stat = fstatSync(0);
          if (!stat.isFIFO() && !process.stdin.isTTY) {
            process.stderr.write(
              "obsidian-tc: transports.stdio and transports.http are both enabled, and stdin is " +
                "neither a TTY nor a pipe (looks like /dev/null) — an immediate stdin EOF is " +
                "expected here; the HTTP transport keeps serving through it. Set " +
                "transports.stdio: false for a headless deploy to silence this.\n",
            );
          }
        } catch {
          // Best-effort notice only — see the comment above.
        }
      }
      await connectStdio(server);
      // GH #995: a stdio client disconnecting closes stdin — the MCP SDK already forwards that
      // to `server.onclose`, but nothing here was listening. Route it through the SAME bounded
      // close() every signal uses; idempotent via close()'s own `closed` flag.
      //
      // Fix (headless HTTP deploy crash-loop): that same EOF fires just as reliably when stdin is
      // simply absent (`docker run -d`, a compose service without `stdin_open: true`, a systemd
      // unit) — nobody disconnected a stdio CLIENT, the process just never had one. When HTTP is
      // also enabled, closing the WHOLE process on that signal takes its listener down too, so
      // this only tears down the stdio transport (which has already closed itself) and process.exit
      // is reserved for stdio being the SOLE transport, matching GH #995's original behavior
      // exactly for that case. stdio and HTTP each get their own McpServer instance (see
      // wireTransports/createMcpServer in transport-wiring.ts) — `server` here is the stdio one
      // alone, so this cannot tear down an HTTP session.
      server.onclose = () => {
        if (config.transports.http.enabled) {
          process.stderr.write(
            "obsidian-tc: stdin closed (stdio transport EOF) — HTTP transport still serving; " +
              "continuing HTTP-only (set transports.stdio: false to silence this for headless " +
              "deploys)\n",
          );
          return;
        }
        void close("transport:stdio-eof") // F3: close() can REJECT — mirrors shutdown.ts's guard
          .catch(logShutdownError)
          .finally(() => process.exit(0));
      };
      process.stderr.write(
        `obsidian-tc ${VERSION} ready on stdio (vault ${firstVault.id}; native=${nativeReadyToken(nativeBindingActive)} vec=${hasVec ? "on" : "off"})\n`,
      );
    } else if (config.transports.http.enabled) {
      process.stderr.write(
        `obsidian-tc ${VERSION} ready (http-only; stdio disabled; vault ${firstVault.id}; native=${nativeReadyToken(nativeBindingActive)} vec=${hasVec ? "on" : "off"})\n`,
      );
    } else {
      process.stderr.write(
        "obsidian-tc: no transport enabled (transports.stdio=false and transports.http.enabled=false); nothing to serve\n",
      );
      process.exit(1);
    }
  };

  const close = async (reason: string): Promise<void> => {
    // Idempotent: a second SIGTERM, or a test calling close() after start() already tore things
    // down, must not re-run (and re-race) the drain below.
    if (closed) return;
    closed = true;
    process.stderr.write(`obsidian-tc: shutting down (${reason})\n`);
    await transports.close().catch(() => {}); // F3: no more requests FIRST (was LAST, after release)
    // GH #995: abort the boot reconcile — left running it embeds with no deadline; both
    // flush() and embed-batches.ts's worker loop check this signal between sub-batches.
    bootReconcileAbort.abort();
    // THE-649: stop watching BEFORE draining. A late filesystem event would otherwise enqueue new
    // coordinator work while indexCoordinator.idle() below is waiting for the queue to empty.
    stopVaultWatch();
    // F3: JOIN the reconcile BEFORE draining below (was the other way round) — see shutdown-phase.ts.
    await joinReconcileOrExit(runReconcile.currentRun(), SHUTDOWN_DRAIN_MS);
    // THE-462/THE-457/GH #995/F3: scheduler/index/job drain race one deadline, same exit-then-throw.
    const drainOpts = { scheduler, indexCoordinator, jobRunner, drainMs: SHUTDOWN_DRAIN_MS };
    await raceShutdownPhaseOrExit(drainOpts);
    await leaderElection.close(); // F3: release the lock LAST, once every writer above has stopped
    morgiana.emit(firstVault.id, "tc.server.shutdown");
    // Every opened resource below gets a best-effort, independently-guarded close — one failing
    // must not skip the rest.
    try {
      await otel.shutdown();
    } catch {
      /* shutdown is best-effort */
    }
    try {
      await governance.close(); // releases the shared rate-limit backend's connection, if any
    } catch {
      /* best-effort */
    }
    try {
      stores.close();
    } catch {
      /* best-effort: closing the cache DB on the way out */
    }
  };

  return { registry, start, close };
}
