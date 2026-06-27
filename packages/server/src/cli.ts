import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FolderAcl, globMatch } from "./acl";
import { writeEvent } from "./audit";
import {
  type BridgeClient,
  buildVaultCapabilities,
  CapabilityCache,
  createBridgeClient,
} from "./bridge";
import { loadConfig } from "./config/load";
import { provisionExperientialDb } from "./db/experiential";
import { runMigrations } from "./db/migrate";
import { openDatabase } from "./db/open";
import { elicitVerifier } from "./elicit";
import { createEmbeddingProvider } from "./embeddings";
import { createGatewayClient, type GatewayClient } from "./gateway";
import { type CallerContext, ToolRegistry } from "./mcp/registry";
import { createMcpServer } from "./mcp/server";
import { startMetricsEndpoint } from "./metrics/endpoint";
import { MetricsRecorder } from "./metrics/registry";
import { MorgianaEmitter } from "./morgiana/emitter";
import { initOtel } from "./otel/tracing";
import type { GatewayRoles } from "./plane/gateway";
import { checkContradictions } from "./plane/jobs/contradiction";
import { createPlurClient } from "./plur/client";
import { type IndexedChunk, type IndexHook, indexNote, indexVault } from "./search/indexer";
import type { Reranker } from "./search/rerank";
import { ensureVecChunks } from "./search/vec";
import { RateLimiter } from "./throttle";
import { createHealthTool } from "./tools/admin/health";
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
import { DEFAULT_MEMORY_FOLDER, DEFAULT_TRACE_FOLDER, registerM5Tools } from "./tools/m5";
import { type M6Deps, registerM6Tools } from "./tools/m6";
import { registerM7Tools } from "./tools/m7";
import { startHttp } from "./transports/http";
import { connectStdio } from "./transports/stdio";
import { resolveMode, type VaultMode } from "./vault/mode";
import { VaultRegistry } from "./vault/registry";

const VERSION = "1.0.0";

// The migration SQL is read relative to this module; the build copies
// src/migrations -> dist/migrations (scripts/copy-assets.mjs) so the bundled
// dist/cli.js resolves it the same way it does from source.
const initialMigrationSql = readFileSync(
  fileURLToPath(new URL("./migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const entityUniqueMigrationSql = readFileSync(
  fileURLToPath(new URL("./migrations/20260519_002_entity_unique.sql", import.meta.url)),
  "utf8",
);
// THE-233 (W-SCHEMA): the wikilink edge graph (vault_graph_expand walks this) lands in the
// authored cache.db alongside chunks; the experiential tier DDL is read here too (bundle-safe
// ./migrations resolution) and applied to a physically separate experiential.db below.
const vaultEdgesMigrationSql = readFileSync(
  fileURLToPath(new URL("./migrations/20260626_001_vault_edges.sql", import.meta.url)),
  "utf8",
);
const experientialInitMigrationSql = readFileSync(
  fileURLToPath(new URL("./migrations/20260626_001_experiential_init.sql", import.meta.url)),
  "utf8",
);
// THE-233 (W-WORKERS): sleep-time plane state tables (contradictions/syntheses/audit_reports/
// job_runs). W-WORKERS left this committed-but-unwired by design; the integration wires it into
// the cache.db migration chain below.
const planeMigrationSql = readFileSync(
  fileURLToPath(new URL("./migrations/20260626_002_plane.sql", import.meta.url)),
  "utf8",
);
async function main(): Promise<void> {
  const configPath = process.argv[2] ?? process.env.OBSIDIAN_TC_CONFIG;
  if (!configPath) {
    process.stderr.write("usage: obsidian-tc <config.json> (or set OBSIDIAN_TC_CONFIG)\n");
    process.exit(2);
  }

  const config = loadConfig(configPath);
  const firstVault = config.vaults[0];
  if (!firstVault) throw new Error("config.vaults must contain at least one vault");
  const startedAt = Date.now();

  mkdirSync(config.cacheDir, { recursive: true });
  const db = await openDatabase(join(config.cacheDir, "cache.db"));
  runMigrations(
    db,
    [
      { version: "20260519_001", sql: initialMigrationSql },
      { version: "20260519_002", sql: entityUniqueMigrationSql },
      { version: "20260626_001", sql: vaultEdgesMigrationSql },
      { version: "20260626_002", sql: planeMigrationSql },
    ],
    { version: VERSION },
  );
  // THE-233 (W-SCHEMA): provision the experiential tier as a physically separate store (the
  // membrane — low-trust per-retrieval state cannot FK into the authored atoms in cache.db,
  // and a reset is a file truncate). Schema only here; the write-on-gate controls + handle
  // threading ride with the capture port (a later slice), so we provision then release.
  const experientialDb = await provisionExperientialDb(
    config.cacheDir,
    [{ version: "20260626_001", sql: experientialInitMigrationSql }],
    { version: VERSION },
  );
  experientialDb.close?.();

  // Prometheus recorder (G2.4) — always live so get_metrics and the optional /metrics scrape
  // share the same in-memory counters. The scrape endpoint is started below only when
  // observability.prometheus.enabled (default off / `:0`).
  // OTEL tracing (G2.4) — no-op unless observability.otel.endpoint is set.
  const otel = initOtel(config.observability, VERSION);
  const metrics = new MetricsRecorder();
  // MORGIANA CloudEvents spool (G2.4) — JSONL by default; a dropped event feeds
  // morgiana_emit_dropped_total + the event_log and never blocks a tool call.
  const morgiana = new MorgianaEmitter({
    cacheDir: config.cacheDir,
    spool: config.observability.morgiana.spool,
    onDropped: (vaultId, reason) => {
      metrics.incMorgianaDropped(vaultId, reason);
      try {
        writeEvent(db, {
          ts: Date.now(),
          vault_id: vaultId,
          status: "skipped",
          error_code: reason,
          event_type: "morgiana_emit_dropped",
        });
      } catch {
        /* event_log is best-effort */
      }
    },
  });
  // Shared rate limiter (G2.4 tiers) — the dispatch gate (THE-210) and get_metrics share it.
  const rateLimiter = new RateLimiter(config.throttle.tiers);
  const registry = new ToolRegistry({
    maxResponseBytes: config.governor.maxResponseBytes,
    idempotencyTtlSeconds: config.idempotencyTtlSeconds,
    verifyElicit: elicitVerifier,
    metrics,
    tracer: otel.tracer,
    emit: (vaultId, type, data) => morgiana.emit(vaultId, type, data),
    rateLimiter,
    toolVisibility: config.toolVisibility,
  });
  registry.register(
    createHealthTool({ version: VERSION, vaults: config.vaults.map((v) => v.id), startedAt }),
  );
  const vaultRegistry = new VaultRegistry(config.vaults, process.env.OBSIDIAN_TC_DEFAULT_VAULT);
  // Index-on-write (THE-255): a note mutation reindexes its path inline (best-effort and
  // backgrounded, so it never slows or fails a write); deindex drops a removed note's chunks
  // via an empty-content reindex (no embedding call). The boot reconcile guarantees full
  // convergence. Shares the one embedding provider + vec-availability flag.
  const embeddingProvider = createEmbeddingProvider(config.embeddings);
  const hasVec = ensureVecChunks(db, embeddingProvider.dimensions, { now: Date.now });

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
  const reranker: Reranker | null = gw
    ? (q, docs, topN) => gw.rerank({ query: q, documents: docs, topN }).then((r) => r.results)
    : null;
  // W-WORKERS generative seam -> gateway extract/synthesize/judge roles (null -> jobs/challenge no-op).
  const roles: GatewayRoles | null = gw
    ? {
        extract: (r) => gw.extract(r).then((x) => ({ text: x.text, model: x.model })),
        synthesize: (r) => gw.synthesize(r).then((x) => ({ text: x.text, model: x.model })),
        judge: (r) => gw.judge(r).then((x) => ({ text: x.text, model: x.model })),
      }
    : null;
  // W-INGEST onIndexed hook -> contradiction-check enqueue. The detector needs the gateway, so we
  // only enqueue when roles are present; the queue is drained best-effort after the boot reconcile.
  const contradictionQueue: Array<{ vaultId: string; chunk: IndexedChunk }> = [];
  const makeOnIndexed = (vaultId: string): IndexHook | undefined =>
    roles
      ? (chunks) => {
          for (const c of chunks) contradictionQueue.push({ vaultId, chunk: c });
        }
      : undefined;

  registerM1Tools(registry, {
    vaultRegistry,
    version: VERSION,
    startedAt,
    embeddings: { provider: config.embeddings.provider, model: config.embeddings.model },
    configPath,
    reindex: (vaultId, path, content) => {
      void indexNote(
        db,
        embeddingProvider,
        vaultId,
        path,
        content,
        hasVec,
        Date.now,
        makeOnIndexed(vaultId),
      ).catch(() => {});
    },
    deindex: (vaultId, path) => {
      void indexNote(db, embeddingProvider, vaultId, path, "", hasVec, Date.now).catch(() => {});
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
    capabilities.set(
      v.id,
      await buildVaultCapabilities(client, {
        probeSkip: v.plugins?.probeSkip,
        forceEnabled: v.plugins?.forceEnabled,
        forceDisabled: v.plugins?.forceDisabled,
        timeoutMs: v.bridges?.probeTimeoutMs,
      }),
    );
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
  const m4Deps: M4Deps = {
    vaultRegistry,
    capabilities,
    bridgeFor: (vaultId) => bridgeClients.get(vaultId),
    timeouts: (vaultId) => timeoutsByVault.get(vaultId) ?? DEFAULT_BRIDGE_TIMEOUTS,
    commandPolicy: (vaultId) => commandsByVault.get(vaultId) ?? { enabled: false, allowlist: [] },
    mode: (vaultId) => modeByVault.get(vaultId) ?? "headless",
  };

  registerM2Tools(registry, {
    vaultRegistry,
    embeddingProvider,
    // search_dql / search_vault(mode:dql) share the Dataview bridge; openBridge
    // applies the same degradation gate (plugin_missing / plugin_unreachable).
    dataviewBridge: (vaultId) => ({
      client: openBridge(m4Deps, vaultId, "dataview").client,
      timeoutMs: bridgeTimeouts(m4Deps, vaultId).timeoutMs,
    }),
  });
  registerM3Tools(registry, { vaultRegistry });
  registerM4Tools(registry, m4Deps);

  // M5 memory/capture substrate (THE-181): capture/memory/workspace are in-process
  // SQLite (+ vault file writes via the M1 path primitives); plur is a global read-only
  // proxy over a config/env endpoint that degrades to plugin_missing when unconfigured.
  const plurClient = createPlurClient(config.plur);
  registerM5Tools(registry, {
    vaultRegistry,
    plur: plurClient,
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
  registerM6Tools(registry, m6Deps);

  // M7 knowledge domain (THE-233 integration): GraphRAG search (W-RETRIEVAL) + decision
  // red-team (W-WORKERS challenge), wired to the gateway seams (graceful when absent).
  registerM7Tools(registry, { vaultRegistry, embeddingProvider, reranker, roles });

  const acl = new FolderAcl(config.acl);

  // stdio is the trusted local transport: the operator runs the binary against
  // their own vault, so calls are authenticated with full local scope.
  const context = (): CallerContext => ({
    caller: "stdio",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: firstVault.id,
    db,
    acl,
  });

  const server = createMcpServer({ name: "obsidian-tc", version: VERSION, registry, context });

  if (config.transports.http.enabled) {
    const http = await startHttp({
      name: "obsidian-tc",
      version: VERSION,
      registry,
      auth: config.auth,
      db,
      vaultId: firstVault.id,
      acl,
      host: config.transports.http.host,
      port: config.transports.http.port,
    });
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

  // Boot-time reconcile (THE-255): re-sync the search index with files changed while the
  // server was down. Incremental (content-hash skip) and best-effort — an embedding-backend
  // or fs hiccup degrades the index, never startup. Backgrounded so it never blocks stdio.
  const indexReadable = (rel: string): boolean =>
    acl.readPaths === undefined ? true : acl.readPaths.some((g) => globMatch(g, rel));
  void Promise.allSettled(
    config.vaults.map((v) =>
      indexVault({
        db,
        provider: embeddingProvider,
        vaultId: v.id,
        root: vaultRegistry.resolve(v.id).root,
        isReadable: indexReadable,
        now: Date.now,
        onIndexed: makeOnIndexed(v.id),
      }),
    ),
  ).then(() => {
    // Best-effort contradiction sweep over chunks enqueued during the boot reconcile. No-op
    // without the gateway (roles null -> queue stays empty). A continuous draining schedule
    // (plane timer / session-close trigger) is a follow-up.
    if (!roles) return;
    const byVault = new Map<string, IndexedChunk[]>();
    for (const { vaultId, chunk } of contradictionQueue.splice(0)) {
      const arr = byVault.get(vaultId) ?? [];
      arr.push(chunk);
      byVault.set(vaultId, arr);
    }
    for (const [vaultId, chunks] of byVault) {
      void checkContradictions({ db, roles, now: Date.now }, vaultId, chunks).catch(() => {});
    }
  });

  morgiana.emit(firstVault.id, "tc.server.start");

  const shutdown = async (): Promise<void> => {
    morgiana.emit(firstVault.id, "tc.server.shutdown");
    try {
      await otel.shutdown();
    } catch {
      /* shutdown is best-effort */
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await connectStdio(server);
  process.stderr.write(`obsidian-tc ${VERSION} ready on stdio (vault ${firstVault.id})\n`);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
