// `buildServerRuntime` is the composition root (stores -> otel/observability -> wireRuntimeCore ->
// job queue/health tools -> gateway seams -> job handlers -> index coordinator/watcher -> M1 ->
// bridge clients/capability snapshots -> M2-M8 -> MCP server -> transports -> scheduler), argv-free,
// returning a `ServerRuntime` whose `start()` fires the boot reconcile/scheduler/stdio and whose
// `close(reason)` is the ordered, idempotent shutdown.
// `stores` (and `otel`) are constructed OUTSIDE `wireRuntimeCore` and handed in as params, then
// folded into its own unwind stack, because real boot's construction order requires them to sit
// textually between `stores` and `governance` — reordering that is forbidden, and accepting an
// arbitrary deps callback would reintroduce the service-locator this file avoids. See
// docs/design/server-runtime.md.

import { dirname } from "node:path";
import type { Tracer } from "@opentelemetry/api";
import type { ServerConfig, VaultConfigInput } from "@the-40-thieves/obsidian-tc-shared";
import { version as VERSION } from "../../package.json";
import type { FolderAcl } from "../acl";
import { experientialMigrations } from "../cli/shared";
import type { EmbeddingsConfigLike } from "../embeddings";
import type { CallerContext, ToolRegistry } from "../mcp/registry";
import type { RegistryOptions } from "../mcp/registry/types";
import { createMcpServer } from "../mcp/server";
import type { MetricsRecorder } from "../metrics/registry";
import type { MorgianaEmitter } from "../morgiana/emitter";
import { initOtel, type OtelHandle } from "../otel/tracing";
import type { Scheduler } from "../scheduler/scheduler";
import type { IndexCoordinator } from "../search/index-coordinator";
import { nativeBindingActive } from "../search/native";
import { createRetrievalCaches } from "../search/query_cache";
import type { VecRebuildEvent } from "../search/vec";
import type { ThrottleTiers } from "../throttle";
import { connectStdio } from "../transports/stdio";
import { emitBootNotices } from "./boot-notices";
import { wireBridges } from "./bridge-wiring";
import { type Governance, wireGovernance } from "./governance";
import {
  type IndexHealthState,
  type IndexResources,
  wireIndexCoordinator,
  wireIndexResources,
} from "./indexing-wiring";
import { createObservability } from "./observability";
import {
  createJobQueue,
  createOnIndexedHook,
  createReconcileRunner,
  wireJobHandlers,
} from "./plane-wiring";
import { wireScheduler } from "./scheduler-wiring";
import { type Stores, wireStores } from "./stores";
import { wireDomainTools, wireGatewaySeams, wireHealthTools, wireM1Tools } from "./tool-wiring";
import { wireTransports } from "./transport-wiring";

/** Public runtime surface: `registry` is what every caller of a fully-composed runtime needs;
 *  `start`/`close` are the only lifecycle verbs. No other runtime state is exposed. */
export interface ServerRuntime {
  registry: ToolRegistry;
  start(): Promise<void>;
  close(reason: string): Promise<void>;
}

/** Guards a boot resource captured by a closure before its own `const`/`let` has run: throws (never
 *  a non-null assertion — forbidden by lint) if the closure is ever invoked early. THE-466. Shared
 *  by `wireRuntimeCore`'s `indexHealth` forward-reference and cli.ts's
 *  `indexCoordinatorRef`/`schedulerRef`. See docs/design/server-runtime.md. */
export function requireBoot<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} read before boot completed`);
  return value;
}

/** THE-906: the boot ready line's `native=` token. `active` MUST be `nativeBindingActive` (the
 *  real napi binding serving), never `nativeResolved` — the latter stays true even when
 *  `packages/native/index.js` silently substituted its own JS fallback.js (#857), which would
 *  print `native=on` on a process that is, in fact, running pure JS. */
export function nativeReadyToken(active: boolean): "on" | "js-fallback" {
  return active ? "on" : "js-fallback";
}

/** `name` is a plain `string`, not a closed union — `wireRuntimeCore` and `buildServerRuntime` each
 *  push their own fixed set of layer names onto the same `OwnedLayer`/`unwindReversed` machinery. */
interface OwnedLayer {
  name: string;
  close(): void | Promise<void>;
}

/**
 * Runs each already-built layer's cleanup in REVERSE (most-recently-opened-first) order — the
 * resource-acquisition-is-cleanup pattern used when a later wiring step throws. A layer that was
 * never built never contributes a cleanup call. Exported and independently tested; see
 * server-runtime.test.ts.
 */
export async function unwindReversed(
  layers: readonly OwnedLayer[],
  onCleanup?: (name: OwnedLayer["name"]) => void,
): Promise<void> {
  for (const layer of [...layers].reverse()) {
    await layer.close();
    onCleanup?.(layer.name);
  }
}

export interface RuntimeCoreDeps {
  /** Already-open stores. Ownership of its cleanup transfers to this call for its duration — see
   *  this file's header comment for why stores is built outside and handed in rather than
   *  constructed here. */
  stores: Stores;
  /** THE-737: trace storage root (config.cacheDir) — governance's sessionTracer resolves a
   *  cache-store session's trace against it instead of the vault root. */
  cacheDir: string;
  /** THE-736: `sessions.traceContent` — capture dispatch arguments onto the trace. */
  traceContent?: boolean;
  /** Already-initialized OTEL handle, opened between `stores` and this call in real boot. Optional
   *  (unit tests of `wireRuntimeCore` omit it). When present, `shutdown()` runs best-effort on
   *  unwind — its rejection is swallowed so it can never replace the real construction error that
   *  is propagating. See docs/design/server-runtime.md. */
  otel?: Pick<OtelHandle, "shutdown">;
  // governance
  vaults: VaultConfigInput[];
  /** config.acl — root ACL, inherited by any vault without its own. */
  acl: ConstructorParameters<typeof FolderAcl>[0];
  /** OBSIDIAN_TC_DEFAULT_VAULT */
  defaultVaultId: string | undefined;
  elicitTtlSeconds: number;
  throttle: { enabled: boolean; tiers: ThrottleTiers };
  maxResponseBytes: number;
  idempotencyTtlSeconds: number;
  idempotencyReclaimSeconds: number;
  toolVisibility: RegistryOptions["toolVisibility"];
  tracer: Tracer | undefined;
  morgiana: Pick<MorgianaEmitter, "emit">;
  // shared
  metrics: MetricsRecorder;
  // index resources
  embeddings: EmbeddingsConfigLike & {
    batchSize: number;
    concurrency: number;
    maxBatchTokens: number;
    chunkContext: boolean;
  };
  onVecRebuild: (event: VecRebuildEvent) => void;
  /** `dirname(configPath)` — the trust root for embeddings.modulePath (the module hatch). Undefined
   *  only when `configPath` itself is absent, NOT in zero-config vault-path mode. See
   *  `ResolveContext.configDir`'s doc comment (providers/types.ts) and docs/design/server-runtime.md. */
  configDir?: string;
  securityProfile?: "hardened" | "trusted-local";
  /** Test-only: fires with each layer's name, in the order its cleanup ran. Only invoked when a
   *  later step throws during construction — never on the happy path, never by production callers. */
  onCleanup?: (name: OwnedLayer["name"]) => void;
}

export interface RuntimeCore {
  governance: Governance;
  indexResources: IndexResources;
}

/**
 * Composes governance -> index resources on top of already-open stores, with no process-argument
 * parsing (constructible in a test without parsing argv). If governance or index resources throws
 * during construction, every already-built layer's cleanup — INCLUDING the stores (and, when
 * supplied, otel) handed in — runs in reverse order via `unwindReversed` before the error
 * propagates, so a partial boot never leaks an open db handle or a live OTEL exporter.
 */
export async function wireRuntimeCore(deps: RuntimeCoreDeps): Promise<RuntimeCore> {
  const built: OwnedLayer[] = [{ name: "stores", close: deps.stores.close }];
  // otel opens right after stores in real boot, so its cleanup slots in here too. `.catch` swallows
  // a shutdown() rejection so it can never replace the real error `unwindReversed` is propagating.
  if (deps.otel) {
    const otel = deps.otel;
    built.push({ name: "otel", close: () => otel.shutdown().catch(() => {}) });
  }
  // THE-457 (governance's onAuditFailure): indexHealth is constructed one step AFTER the registry
  // that closes over it — same forward-reference shape as cli.ts's indexCoordinatorRef/schedulerRef.
  let indexHealthRef: IndexHealthState | undefined;
  try {
    const governance = wireGovernance({
      db: deps.stores.db,
      cacheDir: deps.cacheDir,
      ...(deps.traceContent !== undefined ? { traceContent: deps.traceContent } : {}),
      vaults: deps.vaults,
      acl: deps.acl,
      defaultVaultId: deps.defaultVaultId,
      elicitTtlSeconds: deps.elicitTtlSeconds,
      throttle: deps.throttle,
      maxResponseBytes: deps.maxResponseBytes,
      idempotencyTtlSeconds: deps.idempotencyTtlSeconds,
      idempotencyReclaimSeconds: deps.idempotencyReclaimSeconds,
      toolVisibility: deps.toolVisibility,
      metrics: deps.metrics,
      tracer: deps.tracer,
      morgiana: deps.morgiana,
      ...(deps.stores.episodeCapture ? { onEpisode: deps.stores.episodeCapture } : {}),
      getAuditWriteFailureCounter: () => requireBoot(indexHealthRef, "indexHealth"),
    });
    built.push({ name: "governance", close: governance.close });

    const indexResources = await wireIndexResources({
      db: deps.stores.db,
      metrics: deps.metrics,
      embeddings: deps.embeddings,
      onVecRebuild: deps.onVecRebuild,
      configDir: deps.configDir,
      securityProfile: deps.securityProfile,
    });
    indexHealthRef = indexResources.indexHealth;
    built.push({ name: "indexResources", close: () => {} });

    return { governance, indexResources };
  } catch (err) {
    await unwindReversed(built, deps.onCleanup);
    throw err;
  }
}

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
  // Trust root for a `module` provider's modulePath (embeddings.modulePath / reranker.modulePath):
  // cwd in a container is arbitrary, so a relative modulePath resolves against the config FILE's
  // directory instead, and is refused entirely when `configPath` is absent (module-loader.ts).
  // `configPath` is not always a config file — see docs/design/server-runtime.md for the
  // zero-config vault-path case.
  const configDir = configPath !== undefined ? dirname(configPath) : undefined;
  const startedAt = Date.now();

  const stores = await wireStores({
    cacheDir: config.cacheDir,
    version: VERSION,
    experiential: config.experiential,
    experientialMigrations,
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
  // indexCoordinator and scheduler are constructed further down; the observability module reads
  // them through these lazily-assigned refs so its gauge sources see the live objects at scrape
  // time without the recorder having to be constructed after them.
  let indexCoordinatorRef: IndexCoordinator | undefined;
  let schedulerRef: Scheduler | undefined;
  const observability = createObservability({
    db,
    cacheDir: config.cacheDir,
    morgianaSpool: config.observability.morgiana.spool,
    retrievalCaches,
    getIndexCoordinatorStats: () => requireBoot(indexCoordinatorRef, "indexCoordinator").stats(),
    getSchedulerStats: () => requireBoot(schedulerRef, "scheduler").stats(),
    getHttpConstructSeconds: () => httpConstructSeconds,
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
    maxResponseBytes: config.governor.maxResponseBytes,
    idempotencyTtlSeconds: config.idempotencyTtlSeconds,
    idempotencyReclaimSeconds: config.idempotencyReclaimSeconds,
    toolVisibility: config.toolVisibility,
    metrics,
    tracer: otel.tracer,
    morgiana,
    // otel is opened just above, between `stores` and this call — handing it in folds its shutdown
    // into wireRuntimeCore's own unwind if governance or index resources throws. `onCleanup` fires
    // here only when `wireRuntimeCore` itself throws (a distinct failure window from postCoreLayers
    // below).
    otel,
    onCleanup,
    embeddings: config.embeddings,
    onVecRebuild: observability.onVecRebuild,
    configDir,
    securityProfile: config.securityProfile,
  });
  const { acl, aclByVault, vaultRegistry, activeSessions, rateLimiter, registry } = governance;
  const {
    embeddingProvider,
    embedConfig,
    hasVec,
    hasFts,
    indexHealth,
    recordIngestStatsFor,
    indexVaultRecorded,
  } = indexResources;

  // A later construction failure (e.g. wireTransports below) must still close what this function
  // went on to open after `wireRuntimeCore` succeeded: the vault watcher and any transport socket,
  // then governance and stores, in reverse order via `unwindReversed`. `indexResources` contributes
  // no cleanup of its own, so it is not repeated here.
  const postCoreLayers: OwnedLayer[] = [
    { name: "stores", close: stores.close },
    { name: "governance", close: governance.close },
  ];
  // requireBoot idiom (see this file's top): assigned once, at the end of the try block, after
  // every post-core construction step succeeds; the catch below always rethrows, so the guard on
  // the read after try/catch never actually fires in production.
  let postCore:
    | {
        runReconcile: () => Promise<void>;
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

  try {
    // #14: durable contradiction jobs. Constructed here (ahead of its natural "plane" home) so
    // server_health's getJobQueueStats accessor below can close over it.
    const jobQueue = createJobQueue(db, sqlHooksFor);

    // server_health / get_index_status: the two tools NOT counted in boot.tools_registered (see
    // tool-wiring.ts's header comment) — registered here (not earlier) so hasVec is known.
    wireHealthTools({
      registry,
      version: VERSION,
      vaults: config.vaults,
      startedAt,
      hasVec,
      hasFts,
      indexHealth,
      getIndexCoordinatorStats: () => requireBoot(indexCoordinatorRef, "indexCoordinator").stats(),
      getJobQueueStats: () => jobQueue.stats(),
    });

    const { reranker, roles } = await wireGatewaySeams(
      config.embeddings,
      config.reranker,
      configDir,
      config.securityProfile,
      config.gateway,
    );
    gatewayConfigured = roles !== null;

    // W-INGEST onIndexed hook -> contradiction-check enqueue.
    // THE-822: plane.enabled gates this alongside roles — a disabled plane must not enqueue
    // per-chunk contradiction jobs on every index write.
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
      // THE-717: citation pass needs the AUTHORED store + a query-side embedder, unlike other plane
      // jobs. Passed unconditionally; wireJobHandlers decides whether to register anything.
      citationInfer: config.experiential.citationInfer,
      cacheDb: db,
      embed: (texts) => embeddingProvider.embed(texts, { input: "query" }),
    });

    // THE-291 (part 2)/THE-455/THE-453/THE-649: the coordinator, the reindex/deindex hooks, and the
    // vault watcher.
    const { indexCoordinator, indexReadableFor, reindexHook, deindexHook, stopVaultWatch } =
      wireIndexCoordinator({
        db,
        embeddingProvider,
        hasVec,
        chunkContext: config.embeddings.chunkContext,
        chunkTokens: config.indexing.chunkTokens, // THE-424
        indexing: config.indexing,
        vaults: config.vaults,
        watch: config.watch,
        sqlHooksFor,
        indexHealth,
        acl,
        aclByVault,
        makeOnIndexed,
      });
    // THE-466 slice 2: hand the live coordinator to the observability module's lazy gauge sources.
    indexCoordinatorRef = indexCoordinator;
    // THE-649: pushed immediately (first layer after wireRuntimeCore) so a later throw stops it too.
    postCoreLayers.push({ name: "watcher", close: () => stopVaultWatch() });

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
      sqlHooksFor,
      onVecRebuild: observability.onVecRebuild,
      makeOnIndexed,
      indexVaultRecorded,
      experientialOpen,
      experientialDb,
    });

    // M4 plugin bridges (THE-180): per-vault client + probed capability snapshot, built before M2 so search_dql can share the same Dataview bridge.
    const { capabilities, memoryFolderByVault, traceFolderByVault, m4Deps } = await wireBridges({
      vaults: config.vaults,
      vaultRegistry,
      reindex: reindexHook,
    });

    wireDomainTools({
      registry,
      config,
      vaultRegistry,
      embeddingProvider,
      representation: indexResources.representation,
      ...(retrievalLog ? { retrievalLog } : {}),
      m4Deps,
      hasFts,
      indexHealth,
      recordIngestStatsFor,
      reindex: reindexHook,
      deindex: deindexHook,
      activeSessions,
      memoryFolderByVault,
      traceFolderByVault,
      rateLimiter,
      version: VERSION,
      startedAt,
      capabilities,
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
    });

    // stdio is the trusted local transport: the operator runs the binary against their own vault, so
    // calls are authenticated with full local scope. THE-514: signal is the SDK's per-request
    // extra.signal, threaded through so a caller that cancels a stdio call stops runDispatch at the
    // next stage boundary.
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
    });
    httpConstructSeconds = transports.httpConstructSeconds;
    postCoreLayers.push({ name: "transports", close: () => transports.close() });

    // THE-458 item 6: re-sync the search index with the vault, both at boot (fire-and-forget, see
    // start() below) and on the scheduler.
    const runReconcile = createReconcileRunner({
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
      sqlHooksFor,
      onVecRebuild: observability.onVecRebuild,
      makeOnIndexed,
      indexHealth,
      streamingWalk: config.indexing.streamingWalk,
      indexVaultRecorded,
      roles,
      jobRunner,
    });

    const scheduler = wireScheduler({
      config,
      db,
      vaults: config.vaults,
      eventVaultId: firstVault.id,
      experientialOpen,
      experientialDb,
      observability,
      morgiana,
      roles,
      jobQueue,
      jobRunner,
      runReconcile,
      embeddingProvider,
      ...(transports.advisoryBus ? { advisoryBus: transports.advisoryBus } : {}), // THE-634
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
    // Boot pass: backgrounded so it never blocks stdio, exactly as before.
    void runReconcile();

    morgiana.emit(firstVault.id, "tc.server.start");

    scheduler.start();

    // Security posture summary, THE-825 plane opt-in notice, THE-891 capture first-run notice —
    // all three folded into one call; see boot-notices.ts's header for why they moved out of here.
    emitBootNotices({ config, gatewayConfigured, planeEnabledExplicit });

    // THE-288: honor transports.stdio. Default (true) connects the stdio MCP transport; when
    // false the server serves HTTP-only (the listening socket keeps the process alive), and if
    // neither transport is enabled there is nothing to serve, so exit with a clear message.
    if (config.transports.stdio) {
      await connectStdio(server);
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
    // THE-649: stop watching BEFORE draining. A late filesystem event would otherwise enqueue new
    // coordinator work while indexCoordinator.idle() below is waiting for the queue to empty.
    stopVaultWatch();
    // THE-462: one bounded stop replaces the four stop functions — clears the timer, aborts the
    // in-flight run's AbortSignal, and awaits settle under the scheduler's deadline.
    await scheduler.stop();
    morgiana.emit(firstVault.id, "tc.server.shutdown");
    // THE-457: drain in-flight work under a bounded deadline before exit, so a write mid-index
    // isn't lost and SQLite closes cleanly. Never hang — race the drain against a timeout.
    await Promise.race([
      (async () => {
        await indexCoordinator.idle().catch(() => {});
        // #14: durable jobs survive the process exiting mid-lease (claim()'s lease-expiry reclaim
        // picks them up); this bounded best-effort pass just gives a live worker a chance to clear
        // the queue before exit instead of always waiting out the lease. See docs/design/server-runtime.md.
        const shutdownDrain = new AbortController();
        setTimeout(() => shutdownDrain.abort(), SHUTDOWN_DRAIN_MS).unref();
        await jobRunner.drainOnce(shutdownDrain.signal).catch(() => {});
      })(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, SHUTDOWN_DRAIN_MS).unref();
      }),
    ]);
    // Every opened resource below gets a best-effort, independently-guarded close — one failing
    // must not skip the rest.
    try {
      await transports.close();
    } catch {
      /* best-effort: closing the HTTP/metrics sockets on the way out */
    }
    try {
      await otel.shutdown();
    } catch {
      /* shutdown is best-effort */
    }
    try {
      stores.close();
    } catch {
      /* best-effort: closing the cache DB on the way out */
    }
  };

  return { registry, start, close };
}
