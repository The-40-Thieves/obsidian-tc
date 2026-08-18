// WP5.2 (issue 16): run_serve's M1-M8 tool-dependency composition + registration, extracted
// verbatim out of cli.ts, PLUS the two tools the map's trap list calls out by name: `health` and
// `index_status` register inline from live runtime state (not from a module registrar), which is
// why `boot.tools_registered` (eval/perf/collectors/boot.ts) is pinned 2 lower than
// REGISTERED_TOOL_COUNT — see that collector's probe, which imports tools/m1..m8's registrars
// DIRECTLY and never touches this file or cli.ts, so moving these call sites changes nothing it
// measures.
//
// `wireM1Tools` runs BEFORE bridge-wiring.ts (M1 has no bridge dependency); `wireDomainTools` (M2-M8)
// runs AFTER it, because M2's dataviewBridge / M3's templaterBridge / M4 itself all read the
// composed M4Deps object bridge-wiring.ts returns.
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { DEFAULT_MEMORY_FOLDER, err } from "@the-40-thieves/obsidian-tc-shared";
import type { CapabilityCache } from "../bridge";
import type { WriteTxnHooks } from "../db/txn";
import type { Database } from "../db/types";
import type { EmbeddingProvider } from "../embeddings";
import type { RetrievalLogger } from "../experiential/log";
import { createGatewayClient, type GatewayClient } from "../gateway";
import type { ToolRegistry } from "../mcp/registry";
import { buildModelTierReranker } from "../model";
import type { GatewayRoles } from "../plane/gateway";
import { createPlurBackend } from "../plur/client";
import { resolveReranker } from "../providers/registry";
import { rerankerBuildBlocker } from "../providers/reranker-preflight";
import type { StageMetric } from "../search/graph_search_stages/instrumentation";
import type { IndexHook, IndexStats, IndexVaultArgs } from "../search/indexer";
import { nativeLoaded } from "../search/native";
import type { RetrievalCaches } from "../search/query_cache";
import type { RepresentationManifest } from "../search/representation";
import type { Reranker, RerankOutcome } from "../search/rerank";
import type { VecRebuildEvent } from "../search/vec";
import type { RateLimiter } from "../throttle";
import { createHealthTool, createIndexStatusTool } from "../tools/admin/health";
import { registerM1Tools } from "../tools/m1";
import { registerM2Tools } from "../tools/m2";
import { registerM3Tools } from "../tools/m3";
import { bridgeTimeouts, type M4Deps, openBridge, registerM4Tools } from "../tools/m4";
import { DEFAULT_TRACE_FOLDER, registerM5Tools } from "../tools/m5";
import { type M6Deps, registerM6Tools } from "../tools/m6";
import { registerM7Tools } from "../tools/m7";
import { registerM8Tools } from "../tools/m8";
import type { VaultRegistry } from "../vault/registry";
import type { ActiveSessionTracker } from "../workspace/sessions";
import type { IndexHealthState } from "./indexing-wiring";

export interface HealthToolsDeps {
  registry: ToolRegistry;
  version: string;
  /** config.vaults, narrowed to ids. */
  vaults: readonly { id: string }[];
  startedAt: number;
  hasVec: boolean;
  hasFts: boolean;
  indexHealth: IndexHealthState;
  /** requireBoot(indexCoordinatorRef, ...).stats() — called separately for `.queued` and
   *  `.active`, matching the two call sites this replaces exactly (see cli.ts's original
   *  server_health registration). */
  getIndexCoordinatorStats: () => { queued: number; active: number };
  getJobQueueStats: () => {
    queued: number;
    running: number;
    retrying: number;
    failed: number;
    oldestQueuedAgeMs: number | null;
  };
}

/**
 * Register `health` and `index_status` — the two tools that read live runtime state rather than
 * being built by a module registrar, and so are NOT part of `boot.tools_registered`'s 148.
 * server_health surfaces the build's active fast-paths (native module + sqlite-vec); registered
 * here (not earlier) so hasVec is known. get_index_status is a thin, named, agent-discoverable
 * reader over the same index-health state (THE-491).
 */
export function wireHealthTools(deps: HealthToolsDeps): void {
  deps.registry.register(
    createHealthTool({
      version: deps.version,
      vaults: deps.vaults.map((v) => v.id),
      startedAt: deps.startedAt,
      nativeLoaded,
      vecEnabled: deps.hasVec,
      ftsEnabled: deps.hasFts,
      getIndexHealth: (authenticated) => ({
        reconcile: deps.indexHealth.reconcile,
        reconcile_at: deps.indexHealth.reconcileAt,
        write_failures: deps.indexHealth.writeFailures,
        notes_ready: deps.indexHealth.notesReady,
        ...(authenticated
          ? {
              detail: {
                reconcile_errors: deps.indexHealth.reconcileErrors,
                audit_write_failures: deps.indexHealth.auditWriteFailures,
                // THE-458 (audit #5): index-on-write coordinator depth + backpressure.
                index_queue_depth: deps.getIndexCoordinatorStats().queued,
                index_queue_active: deps.getIndexCoordinatorStats().active,
                index_queue_backpressures: deps.indexHealth.indexQueueBackpressures,
                ...(deps.indexHealth.lastWriteError !== undefined
                  ? { last_write_error: deps.indexHealth.lastWriteError }
                  : {}),
              },
            }
          : {}),
      }),
      getJobQueueStats: deps.getJobQueueStats,
    }),
  );
  deps.registry.register(
    createIndexStatusTool({
      vecEnabled: deps.hasVec,
      ftsEnabled: deps.hasFts,
      getIndexHealth: () => ({
        reconcile: deps.indexHealth.reconcile,
        reconcile_at: deps.indexHealth.reconcileAt,
        write_failures: deps.indexHealth.writeFailures,
        notes_ready: deps.indexHealth.notesReady,
      }),
      getLastChunksUpserted: () => deps.indexHealth.lastChunksUpserted,
    }),
  );
}

export interface GatewaySeams {
  gateway: GatewayClient | null;
  reranker: Reranker | null;
  roles: GatewayRoles | null;
}

/**
 * A DECLARED `reranker` block must never resolve to a silent `null` — only an ABSENT block may
 * (the zero-config-migration guarantee `buildModelTierReranker(embeddings) ?? gatewayReranker`
 * relies on). `resolveReranker` itself legitimately returns `null` for entries whose prerequisite
 * is missing (`model-tier` without `embeddings.modelTier.full`; `gateway` without a base URL) —
 * that is the right contract for a resolver primitive other callers may share. This wrapper is the
 * DECLARED-block-only enforcement point: it turns that null into a boot-time failure naming the
 * provider and what it needed, matching the actionable-hint idiom used throughout
 * providers/registry.ts.
 *
 * `provider: "local"` is a DELIBERATE exception (THE-705 round 2, adversarial review confirmed
 * finding 1). model-tier/gateway's null is a CONFIG-correctness defect — the operator declared a
 * block that structurally cannot work given the REST of their config, and that is always fixable by
 * editing the config. "local"'s null is an ENVIRONMENT-AVAILABILITY question: the optional
 * @the-40-thieves/obsidian-tc-reranker-local package may simply not be resolvable on THIS exact
 * deployment (not yet published to npm, not built in this checkout, no localModulePath override) —
 * treating that identically to a config typo means an operator who opts into an optional capability
 * that happens to be unavailable gets a hard boot crash, which is the opposite of "rerank reachable
 * without a gateway". So "local" degrades exactly like an ABSENT block: this returns `null`,
 * `rerankWithScores` reports `not_configured`, retrieval stays RRF-only. `doctor/checks.ts`'s
 * `rerankerBuildableCheck` (wired with a real resolution probe in cli/commands/doctor.ts) is what
 * keeps this LOUD instead of silently identical to "nothing configured".
 */
async function resolveDeclaredReranker(
  cfg: NonNullable<ServerConfig["reranker"]>,
  ctx: Parameters<typeof resolveReranker>[1],
): Promise<Reranker | null> {
  const reranker = await resolveReranker(cfg, ctx);
  if (reranker) return reranker;
  if (cfg.provider === "local") return null;
  // THE-679: the REASON comes from providers/reranker-preflight.ts, which doctor also reads, so a
  // pre-boot check and this boot-time throw can never disagree about why a block cannot build.
  const blocker = rerankerBuildBlocker(cfg.provider, ctx?.embeddings, {
    baseUrl: cfg.baseUrl,
    gatewayUrlEnv: process.env.OBSIDIAN_TC_GATEWAY_URL,
  });
  if (blocker) {
    throw err.invalidInput(blocker.reason, { provider: cfg.provider, hint: blocker.hint });
  }
  throw err.invalidInput(`reranker.provider "${cfg.provider}" resolved to no reranker`, {
    provider: cfg.provider,
    hint: "this provider's registry entry returned null instead of a reranker (or throwing) for a declared reranker block; that is a bug in the registry entry.",
  });
}

/**
 * THE-233 integration — the optional inference gateway (W-GATEWAY-CLIENT). Unconfigured (no
 * OBSIDIAN_TC_GATEWAY_URL, no gatewayCfg.baseUrl) -> null; every generative seam degrades
 * gracefully rather than failing boot (createGatewayClient throws without a base URL, so guarded
 * with try).
 *
 * THE-832: gatewayCfg.baseUrl/token, when set, win over OBSIDIAN_TC_GATEWAY_URL/_TOKEN —
 * createGatewayClient already implements that precedence (resolveGatewayUrl prefers opts.baseUrl;
 * opts.token ?? the env var), so passing them through is additive and a no-op when gatewayCfg is
 * absent.
 */
export async function wireGatewaySeams(
  embeddings: ServerConfig["embeddings"],
  rerankerCfg?: ServerConfig["reranker"],
  /** Trust root for reranker.modulePath (the module hatch) — see providers/module-loader.ts. */
  configDir?: string,
  securityProfile?: "hardened" | "trusted-local",
  gatewayCfg?: ServerConfig["gateway"],
): Promise<GatewaySeams> {
  let gateway: GatewayClient | null = null;
  try {
    gateway = createGatewayClient({ baseUrl: gatewayCfg?.baseUrl, token: gatewayCfg?.token });
  } catch {
    gateway = null;
  }
  const gw = gateway;
  // W-RETRIEVAL rerank seam -> gateway /rerank passthrough (graceful no-op fallback when null).
  const gatewayReranker: Reranker | null = gw
    ? (q, docs, topN) => gw.rerank({ query: q, documents: docs, topN }).then((r) => r.results)
    : null;
  // Prefer the model-tier BGE /v1/rerank when its service is configured; else the gateway
  // passthrough. Dark until a rerank stage is enabled in graphSearch. A declared `reranker` block
  // wins over that default entirely — ABSENT preserves the historical precedence exactly.
  const reranker: Reranker | null = rerankerCfg
    ? await resolveDeclaredReranker(rerankerCfg, { embeddings, configDir, securityProfile })
    : (buildModelTierReranker(embeddings) ?? gatewayReranker);
  // W-WORKERS generative seam -> gateway extract/synthesize/judge roles (null -> jobs/challenge
  // no-op).
  const roles: GatewayRoles | null = gw ? rolesFrom(gw) : null;
  return { gateway, reranker, roles };
}

/** Adapt a GatewayClient to the three-role seam the workers consume. */
function rolesFrom(gw: GatewayClient): GatewayRoles {
  return {
    extract: (r) => gw.extract(r).then((x) => ({ text: x.text, model: x.model })),
    synthesize: (r) => gw.synthesize(r).then((x) => ({ text: x.text, model: x.model })),
    judge: (r) => gw.judge(r).then((x) => ({ text: x.text, model: x.model })),
  };
}

/**
 * THE-700: a SEPARATE roles seam for the background plane, with a longer retry budget.
 *
 * The Modal endpoints behind the gateway roles scale to zero, and a cold start was measured at
 * >180s — longer than the default 3 attempts x 60s, so every scheduled synthesis pass died with
 * `gateway timed out` while the same request against a warm endpoint took 4.8s.
 *
 * MORE ATTEMPTS, not a longer per-attempt timeout. Each attempt still fails fast; the endpoint
 * warms in the background between them, and a later attempt lands on a hot container. Widening the
 * per-attempt budget instead would hold the caller through the entire wake-up, which is exactly
 * what gateway/client.ts's own comment argues against.
 *
 * SEPARATE from the interactive roles on purpose. `roles` is shared with the M7 challenge tool,
 * where a ~6 minute budget is absurd — a user is waiting. A weekly consolidation pass is not.
 *
 * NOT a ping()-based pre-warm, which was the obvious idea and is wrong: ping() hits LiteLLM's
 * /health, and LiteLLM health-checks EVERY configured model — measured at 60.8s across 470 models
 * spanning 9 hosted providers. Using it to warm one Modal endpoint would issue real billable calls
 * to every unrelated vendor.
 */
export function planeRoles(attempts: number, timeoutMs?: number): GatewayRoles | null {
  try {
    // THE-709: the PER-ATTEMPT budget matters as much as the attempt count. Attempts only rescue a
    // transient failure; a request that deterministically exceeds the per-attempt timeout fails
    // identically every time and merely burns the whole budget (measured: 370.4s twice, 12ms apart
    // — 6 x 60s, not a varying cold start). Omitted rather than passed as undefined so the client's
    // own 60s default still governs when the knob is absent.
    return rolesFrom(
      createGatewayClient({
        maxAttempts: attempts,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      }),
    );
  } catch {
    return null; // unconfigured gateway — same graceful degradation as the interactive seam
  }
}

export interface M1WiringDeps {
  registry: ToolRegistry;
  config: ServerConfig;
  version: string;
  startedAt: number;
  configPath: string | undefined;
  vaultRegistry: VaultRegistry;
  db: Database;
  embeddingProvider: EmbeddingProvider;
  /** THE-683: the boot-built representation identity, passed to indexVault rather than re-derived. */
  representation: RepresentationManifest;
  embedConfig: { batchSize: number; concurrency: number; maxBatchTokens: number };
  hasFts: boolean;
  indexHealth: IndexHealthState;
  onSnapshotSkipped: (vaultId: string, path: string, op: string) => void;
  reindex: (vaultId: string, path: string, content: string) => void;
  deindex: (vaultId: string, path: string) => void;
  indexReadableFor: (vaultId: string) => (rel: string) => boolean;
  sqlHooksFor: (vault: string) => WriteTxnHooks;
  onVecRebuild: (event: VecRebuildEvent) => void;
  makeOnIndexed: (vaultId: string) => IndexHook | undefined;
  indexVaultRecorded: (opts: IndexVaultArgs) => Promise<IndexStats>;
}

/** Registry/metadata/frontmatter/tags/links/graph-analytics/graph-health/snapshot tools (THE-XXX
 *  domains 1-8). Registered before bridge-wiring.ts — M1 has no plugin-bridge dependency. */
export function wireM1Tools(deps: M1WiringDeps): void {
  const { config } = deps;
  registerM1Tools(deps.registry, {
    vaultRegistry: deps.vaultRegistry,
    version: deps.version,
    startedAt: deps.startedAt,
    embeddings: { provider: config.embeddings.provider, model: config.embeddings.model },
    configPath: deps.configPath,
    // THE-374: config-gated snapshot-on-write policy (default off).
    snapshots: { enabled: config.snapshots.enabled, retention: config.snapshots.retention },
    // THE-603: legibility signal when the above no-ops for a destructive write.
    onSnapshotSkipped: deps.onSnapshotSkipped,
    // THE-291 (3B): metadata tools read the notes table once the boot notes pass commits.
    metadataIndex: { hasFts: deps.hasFts, ready: () => deps.indexHealth.notesReady },
    requireCas: config.writes.requireCas,
    // THE-455: M1 shares the coordinator-backed hooks (was an identical inline
    // indexNote/deindexNote).
    reindex: deps.reindex,
    deindex: deps.deindex,
    // THE-376: runtime add_vault triggers a full index of the newly registered vault (mirrors the
    // boot reconcile).
    indexVault: async (vaultId) => {
      const s = await deps.indexVaultRecorded({
        db: deps.db,
        provider: deps.embeddingProvider,
        embed: deps.embedConfig,
        chunkContext: config.embeddings.chunkContext,
        chunkTokens: config.indexing.chunkTokens, // THE-424
        representation: deps.representation,
        densify: config.retrieval.densify,
        vaultId,
        root: deps.vaultRegistry.resolve(vaultId).root,
        isReadable: deps.indexReadableFor(vaultId),
        now: Date.now,
        sql: deps.sqlHooksFor(vaultId),
        onVecRebuild: deps.onVecRebuild,
        onIndexed: deps.makeOnIndexed(vaultId),
        onNotesPass: () => {
          deps.indexHealth.notesReady = true;
        },
        // THE-490/THE-591: indexing.streamingWalk. Off by default -> byte-identical to before.
        walk: { streaming: config.indexing.streamingWalk },
      });
      return { notes_seen: s.notes_seen };
    },
  });
}

export interface DomainToolsDeps {
  registry: ToolRegistry;
  config: ServerConfig;
  vaultRegistry: VaultRegistry;
  embeddingProvider: EmbeddingProvider;
  /** THE-683: the boot-built representation identity, forwarded to M2's index_vault. */
  representation: RepresentationManifest;
  retrievalLog?: RetrievalLogger;
  m4Deps: M4Deps;
  hasFts: boolean;
  indexHealth: IndexHealthState;
  recordIngestStatsFor: (vaultId: string, s: IndexStats) => IndexStats;
  reindex: (vaultId: string, path: string, content: string) => void;
  deindex: (vaultId: string, path: string) => void;
  activeSessions: ActiveSessionTracker;
  memoryFolderByVault: Map<string, string>;
  traceFolderByVault: Map<string, string>;
  rateLimiter: RateLimiter;
  version: string;
  startedAt: number;
  capabilities: CapabilityCache;
  reranker: Reranker | null;
  roles: GatewayRoles | null;
  retrievalCaches: RetrievalCaches;
  onVecFallback: (vault: string, reason: "error" | "underfill") => void;
  onStageMetric: (vault: string, metric: StageMetric) => void;
  /** optional (unlike the two required seams above) — additive and purely observational,
   *  see M7Deps.onRerankOutcome. */
  onRerankOutcome?: (vault: string, outcome: RerankOutcome) => void;
  activationFor?: (chunkId: string) => number | null;
  experientialOpen: boolean;
  experientialDb: Database;
}

/** M2 (index/search) through M8 (experiential) tool registration — everything downstream of the
 *  bridge clients / capability snapshots bridge-wiring.ts builds. */
export function wireDomainTools(deps: DomainToolsDeps): void {
  const { config, registry } = deps;
  const memoryFolder = (vaultId: string): string =>
    deps.memoryFolderByVault.get(vaultId) ?? DEFAULT_MEMORY_FOLDER;
  const traceFolder = (vaultId: string): string =>
    deps.traceFolderByVault.get(vaultId) ?? DEFAULT_TRACE_FOLDER;

  registerM2Tools(registry, {
    vaultRegistry: deps.vaultRegistry,
    embeddingProvider: deps.embeddingProvider,
    // THE-230: serve-path retrieval logging (experiential.logRetrievals).
    ...(deps.retrievalLog ? { retrievalLog: deps.retrievalLog } : {}),
    // THE-406: index_vault must index with the same enrichment as the boot reconcile.
    chunkContext: config.embeddings.chunkContext,
    // THE-424: and at the same chunk budget, for the same reason — a vault indexed by the boot
    // reconcile at one budget and re-indexed by index_vault at another is silently incoherent.
    chunkTokens: config.indexing.chunkTokens,
    // THE-460: index_vault must fold the same revision as the boot reconcile — see
    // search/indexing/index-vault.ts's VecFingerprint construction site.
    representation: deps.representation,
    densify: config.retrieval.densify,
    // THE-490/THE-591: index_vault must walk with the same strategy as the boot reconcile.
    streamingWalk: config.indexing.streamingWalk,
    // search_dql / search_vault(mode:dql) share the Dataview bridge; openBridge applies the same
    // degradation gate (plugin_missing / plugin_unreachable).
    dataviewBridge: (vaultId) => ({
      client: openBridge(deps.m4Deps, vaultId, "dataview").client,
      timeoutMs: bridgeTimeouts(deps.m4Deps, vaultId).timeoutMs,
    }),
    // THE-293: regex execution budget (worker time only).
    regexTimeoutMs: config.governor.regexTimeoutMs,
    // THE-291 (3B): FTS-accelerated search_text once the boot reconcile's notes pass commits.
    metadataIndex: { hasFts: deps.hasFts, ready: () => deps.indexHealth.notesReady },
    // THE-491: get_index_status reports chunks_upserted from the last index_vault call.
    onIndexVaultComplete: (vaultId, stats) => {
      deps.indexHealth.lastChunksUpserted = stats.chunks_upserted;
      deps.recordIngestStatsFor(vaultId, stats);
    },
  });
  registerM3Tools(registry, {
    vaultRegistry: deps.vaultRegistry,
    reindex: deps.reindex,
    // THE-207: periodic-note creation can expand its template through Templater; openBridge
    // applies the same degradation gate.
    templaterBridge: (vaultId) => ({
      client: openBridge(deps.m4Deps, vaultId, "templater").client,
      timeoutMs: bridgeTimeouts(deps.m4Deps, vaultId).templaterTimeoutMs,
    }),
  });
  registerM4Tools(registry, deps.m4Deps);

  // M5 memory/capture substrate (THE-181): capture/memory/workspace are in-process SQLite (+
  // vault file writes via the M1 path primitives); plur is a global read-only proxy that degrades
  // to plugin_missing when unconfigured.
  const plurClient = createPlurBackend(config.plur);
  registerM5Tools(registry, {
    vaultRegistry: deps.vaultRegistry,
    // THE-737: traces live beside cache.db / experiential.db now, not in the vault.
    cacheDir: config.cacheDir,
    activeSessions: deps.activeSessions,
    reindex: deps.reindex,
    plur: plurClient,
    bootstrap: config.bootstrap,
    memoryFolder,
    traceFolder,
  });

  // M6 bulk + URI + admin: one shared RateLimiter (G2.4 tiers from config) is consumed by the
  // bulk tools and snapshotted by get_metrics; the admin tools read non-secret config/ACL/metrics.
  const m6Deps: M6Deps = {
    vaultRegistry: deps.vaultRegistry,
    rateLimiter: deps.rateLimiter,
    version: deps.version,
    startedAt: deps.startedAt,
    authMode: config.auth.mode,
    throttle: config.throttle,
    observability: {
      otel: !!config.observability.otel.endpoint,
      prometheus: config.observability.prometheus.enabled,
      morgiana: config.observability.morgiana.spool || !!config.observability.morgiana.httpEndpoint,
    },
    embeddingsProvider: config.embeddings.provider,
    governorMaxResponseBytes: config.governor.maxResponseBytes,
    capabilities: (vaultId) => deps.capabilities.get(vaultId),
    registeredTools: () => registry.list().length,
    // THE-645 item 2. Lazy for the same reason registeredTools is: M6 is registered onto this
    // registry, so the surface is incomplete at the moment this object is built.
    toolSurface: () => ({ config: registry.visibilityConfig(), tools: registry.list() }),
  };
  registerM6Tools(registry, { ...m6Deps, reindex: deps.reindex, deindex: deps.deindex });

  // M7 knowledge domain (THE-233 integration): GraphRAG search (W-RETRIEVAL) + decision red-team
  // (W-WORKERS challenge), wired to the gateway seams (graceful when absent).
  registerM7Tools(registry, {
    vaultRegistry: deps.vaultRegistry,
    embeddingProvider: deps.embeddingProvider,
    reranker: deps.reranker,
    roles: deps.roles,
    retrieval: config.retrieval,
    ranking: config.ranking,
    // THE-230: serve-path retrieval logging.
    ...(deps.retrievalLog ? { retrievalLog: deps.retrievalLog } : {}),
    // THE-585: vec0 -> brute-force degradation counter.
    onVecFallback: deps.onVecFallback,
    onStageMetric: deps.onStageMetric,
    ...(deps.onRerankOutcome ? { onRerankOutcome: deps.onRerankOutcome } : {}),
    // THE-187/193: activation bubble lookup (dark unless experiential.activationRerank).
    ...(deps.activationFor ? { activationFor: deps.activationFor } : {}),
    // THE-258: class router (dark unless retrieval.classRouter).
    classRouter: config.retrieval.classRouter,
    // THE-132: vault_context's include_work leg reads the experiential store when open.
    ...(deps.experientialOpen ? { edb: deps.experientialDb } : {}),
    // THE-231: same per-vault memory folder as M5.
    memoryFolder,
    // THE-136: bootstrap mode reads the prewarm cache (TTL + signal-hash enforced) and writes
    // through on a live compose.
    prewarmDir: config.cacheDir,
    // THE-562 P1.6: reflect.persist writes through the governed path.
    snapshots: { enabled: config.snapshots.enabled, retention: config.snapshots.retention },
    reindex: deps.reindex,
    // THE-497: the query-product cache (dark unless retrieval.cache.enabled). Built ONCE per
    // process and shared across every dispatch.
    ...(config.retrieval.cache.enabled ? { retrievalCaches: deps.retrievalCaches } : {}),
  });

  // M8 experiential domain (THE-229): work-memory retrieval + management verbs over
  // agent_episodes / chunk_retrievals. With the store closed the tools report unavailable.
  registerM8Tools(registry, {
    ...(deps.experientialOpen ? { edb: deps.experientialDb } : {}),
  });
}
