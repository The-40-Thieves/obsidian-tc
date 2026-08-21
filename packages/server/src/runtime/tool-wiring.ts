// run_serve's M1-M8 tool-dependency composition + registration, plus `health` and `index_status`,
// which register inline from live runtime state rather than from a module registrar (that's why
// `boot.tools_registered` in eval/perf/collectors/boot.ts is pinned 2 lower than
// REGISTERED_TOOL_COUNT — that collector imports tools/m1..m8's registrars directly).
//
// Composition order is load-bearing: `wireM1Tools` runs BEFORE bridge-wiring.ts (M1 has no bridge
// dependency); `wireDomainTools` (M2-M8) runs AFTER it, because M2's dataviewBridge / M3's
// templaterBridge / M4 itself all read the composed M4Deps object bridge-wiring.ts returns.
// See docs/design/runtime-gateway-seams.md for the extraction background.
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
import { nativeBindingActive } from "../search/native";
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
import { buildAcls } from "./acl-build";
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
      // THE-906: `nativeBindingActive`, not merely `nativeResolved` — server_health's
      // `native_loaded` is an operator-facing claim about the real napi binding SERVING, and
      // `nativeResolved` stays true even on packages/native's own internal JS fallback (#857).
      nativeLoaded: nativeBindingActive,
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
      getInFlightProgress: () => deps.indexHealth.inFlight,
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
 * `provider: "local"` is a DELIBERATE exception: unlike model-tier/gateway (a config-correctness
 * defect), a `null` here is an environment-availability question — the optional
 * @the-40-thieves/obsidian-tc-reranker-local package may simply not be resolvable on this exact
 * deployment. It degrades like an ABSENT block instead of crashing boot. `doctor/checks.ts`'s
 * `rerankerBuildableCheck` keeps this loud rather than silently identical to "nothing configured".
 * Full rationale (THE-705 round 2, #806): docs/design/runtime-gateway-seams.md.
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
 * A SEPARATE roles seam for the background plane, with a longer retry budget and its own
 * per-attempt timeout — MORE ATTEMPTS rather than a longer per-attempt timeout, so each attempt
 * still fails fast while a cold endpoint warms between them. SEPARATE from the interactive `roles`
 * on purpose: that seam is shared with the M7 challenge tool, where a multi-minute budget is
 * absurd (a user is waiting) but a weekly consolidation pass tolerates it fine.
 *
 * Full history and measurements (Modal cold-start budget, the rejected ping()-based pre-warm
 * idea, THE-700 #659 and THE-709): docs/design/runtime-gateway-seams.md.
 */
export function planeRoles(attempts: number, timeoutMs?: number): GatewayRoles | null {
  try {
    // The PER-ATTEMPT budget matters as much as the attempt count — see the design note above.
    // Omitted rather than passed as undefined so the client's own 60s default still governs when
    // the knob is absent.
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
  /** THE-643 item 1: same two fields wireDomainTools already threads for M8/M7's edb use — the
   *  write-time guardrail's point read into note_quality. */
  experientialOpen: boolean;
  experientialDb: Database;
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
    // THE-643 item 1: write_note/append_note/patch_note's quality_warning point read, same gate
    // as M7/M8's edb use below (wireDomainTools).
    ...(deps.experientialOpen ? { edb: deps.experientialDb } : {}),
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
  /** THE-891 item 3: optional, same reason as onRerankOutcome above — see M7Deps.onAclWalkPruned. */
  onAclWalkPruned?: (vault: string, count: number) => void;
  activationFor?: (chunkId: string) => number | null;
  experientialOpen: boolean;
  experientialDb: Database;
}

/** M2 (index/search) through M8 (experiential) tool registration — everything downstream of the
 *  bridge clients / capability snapshots bridge-wiring.ts builds. */
export function wireDomainTools(deps: DomainToolsDeps): void {
  const { config, registry } = deps;
  // Federated multi-vault search's per-vault ACL source (THE-630, #809), built here from `config`
  // rather than threading wireGovernance's already-built objects through — deliberately, at the
  // one-time cost of compiling the same glob rules twice. Rationale:
  // docs/design/runtime-gateway-seams.md.
  const { acl, aclByVault } = buildAcls(config.acl, config.vaults);
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
      // `inFlight` is a SINGLE slot (THE-645); two index_vault calls on DIFFERENT vaults can
      // genuinely overlap since dispatch has no cross-call serialization. Only clear the slot when
      // this completion actually owns it, or vault B finishing would null out vault A's
      // still-running entry. Consequence: while two runs overlap, `in_flight` reports "an"
      // in-flight run, not "all" of them (last-progress-wins) — the entry still carries `vault`, so
      // a caller can tell which one, just not that a second run exists.
      if (deps.indexHealth.inFlight?.vault === vaultId) {
        deps.indexHealth.inFlight = null;
      }
      deps.recordIngestStatsFor(vaultId, stats);
    },
    // THE-645: a failed index_vault call must not leave a stale "still running" entry — see
    // tools/m2/index-tools.ts's try/catch. Same ownership guard as onIndexVaultComplete above: a
    // DIFFERENT vault's still-running entry must survive this vault's rejection.
    onIndexVaultError: (vaultId) => {
      if (deps.indexHealth.inFlight?.vault === vaultId) {
        deps.indexHealth.inFlight = null;
      }
    },
    // THE-645: get_index_status's in-flight progress, updated once per completed flush() batch.
    // Overwrites the single slot regardless of which vault previously held it — see the
    // last-progress-wins note on onIndexVaultComplete above.
    onProgress: (vaultId, p) => {
      deps.indexHealth.inFlight = { vault: vaultId, ...p };
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
    // THE-891 item 3: graph-walk ACL prune counter.
    ...(deps.onAclWalkPruned ? { onAclWalkPruned: deps.onAclWalkPruned } : {}),
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
    // THE-630: federated multi-vault search's per-vault ACL source — see this function's
    // acl/aclByVault construction above and graph-search.ts's aclForVault.
    acl,
    aclByVault,
  });

  // M8 experiential domain (THE-229): work-memory retrieval + management verbs over
  // agent_episodes / chunk_retrievals. With the store closed the tools report unavailable.
  registerM8Tools(registry, {
    ...(deps.experientialOpen ? { edb: deps.experientialDb } : {}),
    // THE-643 item 3: note_quality_report's activation_conflict aggregate reuses the SAME bubble
    // lookup M7 uses for rerank (dark unless experiential.activationRerank) rather than opening a
    // second read path onto vault_object_state.
    ...(deps.activationFor ? { activationFor: deps.activationFor } : {}),
    // THE-642 item 1: work_search's semantic channel reuses the SAME embedding provider M7
    // knowledge search gets above, rather than standing up a second one.
    embeddingProvider: deps.embeddingProvider,
  });
}
