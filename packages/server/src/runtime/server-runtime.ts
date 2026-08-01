// WP5.1 (issue 15) declared `ServerRuntime` and delivered `wireRuntimeCore` (governance -> index
// resources, argv-free, with construction-order-reversed cleanup on failure over already-open
// stores). WP5.2 (issue 16) finishes the job: `buildServerRuntime` below is the actual composition
// root — stores -> otel/observability -> wireRuntimeCore -> job queue/health tools -> gateway seams
// -> job handlers -> index coordinator/watcher -> M1 -> bridge clients/capability snapshots -> M2-M8
// -> MCP server -> transports -> scheduler — returning a `ServerRuntime` whose `start()` is the
// final activation step (fire the boot reconcile, start the scheduler ticking, connect stdio) and
// whose `close(reason)` is the ordered, idempotent shutdown. cli.ts's `run_serve` is now three lines:
// build, install signal handlers (./shutdown.ts), start.
//
// Why stores is a PARAMETER to wireRuntimeCore, not built there: `ToolRegistry` (governance) needs
// the OTEL tracer and the Prometheus/MORGIANA observability module's `metrics`/`morgiana`, both of
// which the observability module (runtime/observability.ts) derives from `stores.db`. Real boot
// therefore has `buildServerRuntime`'s own OTEL-init + `createObservability` call sitting textually
// BETWEEN stores and governance. Folding that gap into `wireRuntimeCore` would mean either
// reordering real boot steps (forbidden) or accepting an arbitrary "give me your deps" callback,
// which starts to look like the service-locator this file is told not to build. Taking `stores` as
// an input and folding its cleanup into THIS call's unwind stack gets the same reverse-order
// guarantee without either problem: a failure in governance or index resources still closes stores,
// in the right order, and the boot-failure test below (extended for WP5.2) exercises exactly that.
//
// One more resource shares this exact shape and was flagged, not fixed, at the time: `otel` (OTEL
// SDK init) also sits textually between `stores` and this call in `buildServerRuntime`, for the same
// reason `stores` does — real boot's construction order forbids reordering it inside. `otel` below is
// the same fix applied a second time: an optional param this call folds into its own unwind, sitting
// between `stores` and `governance` (its real open position), so a throw in governance or index
// resources closes it too — never built inside `wireRuntimeCore` itself.
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
import { nativeLoaded } from "../search/native";
import { createRetrievalCaches } from "../search/query_cache";
import type { VecRebuildEvent } from "../search/vec";
import type { ThrottleTiers } from "../throttle";
import { connectStdio } from "../transports/stdio";
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

/** The map's target shape (WP5). `registry` is the one thing every caller of a fully-composed
 *  runtime needs; `start`/`close` are the two lifecycle verbs — nothing else is public runtime
 *  state. WP5.2 implements this; this slice only declares it. */
export interface ServerRuntime {
  registry: ToolRegistry;
  start(): Promise<void>;
  close(reason: string): Promise<void>;
}

/** THE-466 slice 2's established idiom (see cli.ts's original header comment): a boot resource read
 *  through a closure before the `const`/`let` that holds it has executed is a bug if that closure is
 *  ever CALLED early, and correct — by construction, never called before boot finishes — otherwise. A
 *  thrown Error (never a non-null assertion, forbidden by lint) documents the invariant instead of
 *  silently returning undefined. Moved here from cli.ts because `wireRuntimeCore` below now needs
 *  the same pattern for `indexHealth` (constructed one step after the registry that closes over it);
 *  cli.ts still uses it for `indexCoordinatorRef`/`schedulerRef` (WP5.2) and imports it from here. */
export function requireBoot<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} read before boot completed`);
  return value;
}

/** Layer names are a plain `string`, not a closed union: `wireRuntimeCore` below uses its own
 *  fixed set ("stores"/"otel" (only when supplied)/"governance"/"indexResources"), while
 *  `buildServerRuntime`'s own post-`wireRuntimeCore` unwind stack (further down this file) reuses
 *  the same `OwnedLayer` / `unwindReversed` machinery for a different set
 *  ("watcher"/"transports") — the mechanism is identical, only the inventory of what got built
 *  differs. */
interface OwnedLayer {
  name: string;
  close(): void | Promise<void>;
}

/**
 * Run each already-built layer's cleanup in REVERSE (most-recently-opened-first) order — the
 * resource-acquisition-is-cleanup pattern `wireRuntimeCore` uses when a later wiring step throws.
 * Exported and independently testable: a layer that was never built never contributed a cleanup, so
 * it can never be touched here, and reversing (or dropping) an entry in `layers` is exactly the bug
 * class this function exists to make loud — see server-runtime.test.ts.
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
  /** Already-initialized OTEL handle, opened between `stores` and this call in real boot — see this
   *  file's header comment. Optional: `buildServerRuntime` always supplies it, but the direct
   *  `wireRuntimeCore` tests below construct no OTEL and omit it, so `built` simply has one fewer
   *  entry and behaves exactly as before this was added. When present, `shutdown()` is called
   *  best-effort (its own rejection is swallowed) — a telemetry SDK failing to shut down during
   *  unwind must never replace the real construction error that is propagating. */
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
  /** Test-only observability: fires with each layer's name, in the order its cleanup actually ran.
   *  Only invoked when a later step throws during construction — never on the happy path, and never
   *  by production callers, which omit it. */
  onCleanup?: (name: OwnedLayer["name"]) => void;
}

export interface RuntimeCore {
  governance: Governance;
  indexResources: IndexResources;
}

/**
 * Compose governance -> index resources on top of already-open stores, with no process-argument
 * parsing — the map's acceptance criterion for WP5 ("the runtime is constructible in a test without
 * parsing process arguments"), scoped to what this slice actually extracted. If governance or index
 * resources throws during construction, every already-built layer's cleanup — INCLUDING the stores
 * (and, when supplied, otel) handed in — runs in reverse order (via `unwindReversed`) before the
 * error propagates, so a partial boot never leaks an open db handle or a live OTEL exporter.
 */
export async function wireRuntimeCore(deps: RuntimeCoreDeps): Promise<RuntimeCore> {
  const built: OwnedLayer[] = [{ name: "stores", close: deps.stores.close }];
  // otel opens right after stores in real boot (see this file's header comment), so its cleanup
  // slots in here too — before governance is attempted, after stores. Best-effort by construction:
  // `.catch` swallows a shutdown() rejection so it can never replace the real error `unwindReversed`
  // is already propagating (see `deps.otel`'s doc comment above).
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

    const indexResources = wireIndexResources({
      db: deps.stores.db,
      metrics: deps.metrics,
      embeddings: deps.embeddings,
      onVecRebuild: deps.onVecRebuild,
    });
    indexHealthRef = indexResources.indexHealth;
    built.push({ name: "indexResources", close: () => {} });

    return { governance, indexResources };
  } catch (err) {
    await unwindReversed(built, deps.onCleanup);
    throw err;
  }
}

// THE-457: cap on how long graceful shutdown waits for in-flight index work. Unchanged from
// cli.ts's pre-extraction value — the map's WP5 acceptance criterion is that this timeout does
// not change.
const SHUTDOWN_DRAIN_MS = 5000;

/**
 * WP5.2: the full composition root. Builds every boot resource in the SAME order run_serve used
 * to build them inline — stores, otel/observability, governance+index resources
 * (`wireRuntimeCore`), the job queue (hoisted so the health tool's stats accessor can close over
 * it), the two inline admin tools, the gateway seams, the job handlers/runner, the index
 * coordinator + watcher, M1, the bridge clients/capability snapshots, M2-M8, the MCP server, the
 * transports, and the scheduler (registered, not started) — then returns a `ServerRuntime` whose
 * `start()` is the go-live step (fire the boot reconcile, start the scheduler, connect stdio) and
 * whose `close(reason)` is the ordered, idempotent shutdown.
 *
 * Argv-free: takes an already-resolved `ServerConfig`, never touches `process.argv` — the map's
 * "the runtime is constructible in a test" criterion.
 */
export async function buildServerRuntime(
  config: ServerConfig,
  configPath: string | undefined,
  /** Test-only observability: fires with each already-built layer's name, in the order its cleanup
   *  actually ran, on either failure window this function covers — a construction step AFTER
   *  `wireRuntimeCore` throws (reports its own post-core layers), or `wireRuntimeCore` itself throws
   *  (reports stores/otel/governance via the same callback, passed straight through — see the
   *  `wireRuntimeCore` call below). Never invoked on the happy path, and never passed by production
   *  callers (cli.ts). */
  onCleanup?: (name: string) => void,
): Promise<ServerRuntime> {
  const firstVault = config.vaults[0];
  if (!firstVault) throw new Error("config.vaults must contain at least one vault");
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
    // otel is opened just above, between `stores` and this call — handing it in (like `stores`)
    // folds its shutdown into wireRuntimeCore's own unwind if governance or index resources throws,
    // in the correct reverse-ownership position (after those, before stores). `onCleanup` is the
    // same test-only hook this function already threads through its OWN post-core unwind below; a
    // wireRuntimeCore-level throw is a distinct failure window (stores/otel/governance never reach
    // postCoreLayers), so wiring it here too costs nothing on the happy path or on a post-core
    // failure — it only ever fires when `wireRuntimeCore` itself is what threw.
    otel,
    onCleanup,
    embeddings: config.embeddings,
    onVecRebuild: observability.onVecRebuild,
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

  // Everything from here on is built on top of an already-successful `wireRuntimeCore` — a later
  // construction failure (e.g. the metrics endpoint's non-loopback-bind refusal, deep in
  // wireTransports below) must still close what THIS function itself went on to open: the vault
  // watcher (indexCoordinator has no other stop path) and any transport socket, then governance
  // and stores, in reverse order — the same `unwindReversed` contract `wireRuntimeCore` used above,
  // extended to the layers WP5.2 adds. `indexResources` contributes no cleanup of its own (see
  // `wireRuntimeCore`), so it is not repeated here.
  const postCoreLayers: OwnedLayer[] = [
    { name: "stores", close: stores.close },
    { name: "governance", close: governance.close },
  ];
  // THE-466 slice 2's requireBoot idiom (see this file's top): assigned once, at the very end of
  // the try block below, after every other post-core construction step has succeeded. Read via
  // requireBoot immediately after the try/catch — by construction that point is only reached once
  // this IS assigned (the catch always rethrows), so the guard never actually fires in production;
  // it documents the invariant instead of asserting it away with `!`.
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

    const { reranker, roles } = await wireGatewaySeams(config.embeddings, config.reranker);

    // W-INGEST onIndexed hook -> contradiction-check enqueue.
    const makeOnIndexed = createOnIndexedHook({ jobQueue, roles });

    const { jobRunner } = wireJobHandlers({
      registry,
      db,
      acl,
      jobQueue,
      roles,
      embeddingProvider,
      experientialOpen,
      experientialDb,
      vaults: config.vaults,
    });

    // THE-291 (part 2)/THE-455/THE-453/THE-649: the coordinator, the reindex/deindex hooks, and the
    // vault watcher.
    const { indexCoordinator, indexReadableFor, reindexHook, deindexHook, stopVaultWatch } =
      wireIndexCoordinator({
        db,
        embeddingProvider,
        hasVec,
        chunkContext: config.embeddings.chunkContext,
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
    // THE-649: the watcher is the first layer THIS function itself opens after wireRuntimeCore —
    // pushed as soon as it exists, so a later throw (e.g. wireTransports below) stops it too.
    postCoreLayers.push({ name: "watcher", close: () => stopVaultWatch() });

    wireM1Tools({
      registry,
      config,
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
    });

    // M4 plugin bridges (THE-180): per-vault client + probed capability snapshot. Built before M2 so
    // search_dql can share the same Dataview bridge.
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
      revision: config.embeddings.revision,
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

    // Security posture summary (audit #268 P1): make the active profile obvious at startup, and
    // warn when the permissive trusted-local defaults are active — governed by default is not
    // least-privilege by default. stderr only (the stdio MCP protocol owns stdout).
    {
      const rootAcl = config.acl;
      // THE-526: name the active profile so it is a stated fact, not something inferred from six
      // fields.
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

    // THE-288: honor transports.stdio. Default (true) connects the stdio MCP transport; when
    // false the server serves HTTP-only (the listening socket keeps the process alive), and if
    // neither transport is enabled there is nothing to serve, so exit with a clear message.
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
        // #14: no explicit contradiction drain here any more — durable jobs survive the process
        // exiting mid-lease (claim()'s lease-expiry reclaim picks them up), so there is nothing
        // that would be LOST by skipping a final drain. One bounded best-effort pass still gives a
        // live worker a chance to clear the queue before exit rather than always waiting out the
        // lease.
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
