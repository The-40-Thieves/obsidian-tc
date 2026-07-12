import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { parse as parseYaml } from "yaml";
import { version as VERSION } from "../package.json";
import { FolderAcl, globMatch, isDefaultDenied } from "./acl";
import { writeEvent } from "./audit";
import {
  type BridgeClient,
  buildVaultCapabilities,
  CapabilityCache,
  createBridgeClient,
} from "./bridge";
import { parseCliArgs, redactConfig, resolveServeConfig, USAGE } from "./cli/args";
import { installPlugin } from "./cli/plugin-install";
import { provisionExperientialDb } from "./db/experiential";
import { startMaintenanceSweep } from "./db/maintenance";
import { runMigrations } from "./db/migrate";
import { openDatabase } from "./db/open";
import { elicitVerifier, setDefaultElicitTtlSeconds } from "./elicit";
import { createEmbeddingProvider } from "./embeddings";
import { makeActivationLookup, recomputeActivation } from "./experiential/activation";
import { inferCitations } from "./experiential/citation";
import { contributionReport } from "./experiential/contribution";
import { createEpisodeCapture } from "./experiential/episodes";
import {
  DEFAULT_GAP_THRESHOLD,
  detectGaps,
  parseQueriesFile,
  scoreDistribution,
} from "./experiential/gaps";
import { createRetrievalLogger } from "./experiential/log";
import { vaultMetrics } from "./experiential/metrics";
import { evaluateEpisodes, extractPreferences } from "./experiential/reflect";
import { createGatewayClient, type GatewayClient } from "./gateway";
import { type CallerContext, ToolRegistry } from "./mcp/registry";
import { createMcpServer } from "./mcp/server";
import { startMetricsEndpoint } from "./metrics/endpoint";
import { MetricsRecorder } from "./metrics/registry";
import { MorgianaEmitter } from "./morgiana/emitter";
import { initOtel } from "./otel/tracing";
import type { GatewayRoles } from "./plane/gateway";
import { auditJob } from "./plane/jobs/audit";
import { checkContradictions } from "./plane/jobs/contradiction";
import { synthesisJob } from "./plane/jobs/synthesis";
import { SleepTimePlane, startPlaneScheduler } from "./plane/plane";
import { createPlurBackend } from "./plur/client";
import { assignClusters } from "./search/cluster";
import { ensureNotesFts } from "./search/fts";
import { graphSearch } from "./search/graph_search";
import {
  deindexNote,
  type IndexedChunk,
  type IndexHook,
  indexNote,
  indexVault,
} from "./search/indexer";
import { nativeLoaded } from "./search/native";
import { prewarmPathFor, writePrewarm } from "./search/prefetch";
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
import { registerM8Tools } from "./tools/m8";
import { startHttp } from "./transports/http";
import { connectStdio } from "./transports/stdio";
import { resolveMode, type VaultMode } from "./vault/mode";
import { resolveVaultPath } from "./vault/paths";
import { VaultRegistry } from "./vault/registry";
import { ActiveSessionTracker, appendTrace, getSession } from "./workspace/sessions";

// VERSION derives from packages/server/package.json (imported above): single source of
// truth, bumped by the release pipeline. Matches MCP versioning guidance (extract from
// package metadata, do not hardcode); resolveJsonModule is on, so bun inlines it at build.

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
const experientialOutcomeMigrationSql = readFileSync(
  fileURLToPath(new URL("./migrations/20260711_001_experiential_outcome.sql", import.meta.url)),
  "utf8",
);
const experientialAgentEpisodesMigrationSql = readFileSync(
  fileURLToPath(new URL("./migrations/20260711_002_agent_episodes.sql", import.meta.url)),
  "utf8",
);
// THE-222: the versioned preference profile (typed-delta updates only) for the reflect pass.
const preferenceProfileMigrationSql = readFileSync(
  fileURLToPath(new URL("./migrations/20260712_001_preference_profile.sql", import.meta.url)),
  "utf8",
);
// THE-44: derive-don't-mutate access instrumentation (chunk_access_stats view).
const accessViewsMigrationSql = readFileSync(
  fileURLToPath(new URL("./migrations/20260712_002_access_views.sql", import.meta.url)),
  "utf8",
);
// The experiential.db chain, applied by every entry point that opens the store (serve +
// activation-recompute) so they can never diverge on schema.
const experientialMigrations = [
  { version: "20260626_001", sql: experientialInitMigrationSql },
  { version: "20260711_001", sql: experientialOutcomeMigrationSql },
  { version: "20260711_002", sql: experientialAgentEpisodesMigrationSql },
  { version: "20260712_001", sql: preferenceProfileMigrationSql },
  { version: "20260712_002", sql: accessViewsMigrationSql },
];
// THE-233 (W-WORKERS): sleep-time plane state tables (contradictions/syntheses/audit_reports/
// job_runs). W-WORKERS left this committed-but-unwired by design; the integration wires it into
// the cache.db migration chain below.
const planeMigrationSql = readFileSync(
  fileURLToPath(new URL("./migrations/20260626_002_plane.sql", import.meta.url)),
  "utf8",
);
// THE-291: per-note metadata table (notes_fts is runtime-provisioned, never in this chain).
const notesMigrationSql = readFileSync(
  fileURLToPath(new URL("./migrations/20260702_001_notes.sql", import.meta.url)),
  "utf8",
);
// THE-310: vault_id on vault_edges so multi-vault GraphRAG reconcile/expansion is isolated.
const vaultEdgesVaultIdMigrationSql = readFileSync(
  fileURLToPath(new URL("./migrations/20260703_001_vault_edges_vault_id.sql", import.meta.url)),
  "utf8",
);
// THE-374: point-in-time snapshot store (snapshot_blobs + note_snapshots) for restore_note.
const snapshotsMigrationSql = readFileSync(
  fileURLToPath(new URL("./migrations/20260709_001_snapshots.sql", import.meta.url)),
  "utf8",
);
async function main(): Promise<void> {
  const cmd = parseCliArgs(process.argv.slice(2));
  if (cmd.kind === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (cmd.kind === "help") {
    process.stdout.write(USAGE);
    return;
  }
  if (cmd.kind === "error") {
    process.stderr.write(`${cmd.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (cmd.kind === "plugin-install") {
    const pluginSrcDir = fileURLToPath(new URL("./plugin/", import.meta.url));
    try {
      const r = installPlugin(cmd.vaultPath, pluginSrcDir);
      process.stdout.write(
        `installed ${r.pluginName} v${r.pluginVersion} -> ${r.dest}\n` +
          `Enable it in Obsidian: Settings -> Community plugins -> ${r.pluginId}.\n`,
      );
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
      process.exit(2);
    }
    return;
  }
  // resolveServeConfig surfaces user-facing CliErrors (no path given, missing file, bad
  // config). Both the `config` subcommands and `serve` treat these as usage errors: print the
  // message + usage to stderr and exit 2, distinct from the `fatal:`/exit 1 in main().catch
  // that is reserved for genuine server crashes.
  const resolveOrUsageExit = (input?: string): ServerConfig => {
    try {
      return resolveServeConfig(input);
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
      process.exit(2);
    }
  };
  if (cmd.kind === "config-show" || cmd.kind === "config-validate") {
    const resolved = resolveOrUsageExit(cmd.configPath);
    process.stdout.write(
      cmd.kind === "config-show"
        ? `${JSON.stringify(redactConfig(resolved), null, 2)}\n`
        : "config valid\n",
    );
    return;
  }

  // THE-73 Phase 2: offline chunk clustering (populates chunks.cluster_id for the graph_search
  // diversification cap). Reuses the serve config + cache.db; does not start a server.
  if (cmd.kind === "cluster") {
    const clusterConfig = resolveOrUsageExit(cmd.input);
    mkdirSync(clusterConfig.cacheDir, { recursive: true });
    const clusterDb = await openDatabase(join(clusterConfig.cacheDir, "cache.db"));
    try {
      let total = 0;
      for (const v of clusterConfig.vaults) {
        const stats = assignClusters(clusterDb, v.id, cmd.k !== undefined ? { k: cmd.k } : {});
        if (stats) {
          total += stats.chunks;
          process.stdout.write(
            `clustered ${v.id}: ${stats.chunks} chunks -> ${stats.k} clusters (${stats.iters} iters)\n`,
          );
        } else {
          process.stdout.write(`clustered ${v.id}: no embedded chunks (run index_vault first)\n`);
        }
      }
      process.stdout.write(
        `done: ${total} chunks across ${clusterConfig.vaults.length} vault(s)\n`,
      );
    } finally {
      clusterDb.close?.();
    }
    return;
  }

  // THE-227: offline ACT-R activation recompute — reads chunk_retrievals and writes
  // cached_activation_score into vault_object_state (both in the experiential store), so
  // bubble_safe_rerank becomes non-inert once retrieval logging has populated the log.
  if (cmd.kind === "activation-recompute") {
    const actCfg = resolveOrUsageExit(cmd.input);
    mkdirSync(actCfg.cacheDir, { recursive: true });
    const edb = await provisionExperientialDb(actCfg.cacheDir, experientialMigrations, {
      version: VERSION,
    });
    try {
      const stats = recomputeActivation(edb, Date.now());
      process.stdout.write(`activation recompute: ${stats.chunks} chunk(s) updated\n`);
    } finally {
      edb.close?.();
    }
    return;
  }

  // THE-170: on-demand citation inference — stage 1 ROUGE-L + stored-embedding cosine over a
  // session transcript, stage 2 judge via the gateway role seam (5% parse kill switch), then
  // stamp cited_in_response / citation_score on the scoped chunk_retrievals rows.
  if (cmd.kind === "citation-infer") {
    const cfg = resolveOrUsageExit(cmd.input);
    if (!cmd.transcript || (!cmd.session && cmd.since === undefined)) {
      process.stderr.write(
        `citation-infer requires --transcript <file> and --session <id> or --since <ms> [--until <ms>]\n\n${USAGE}`,
      );
      process.exit(2);
    }
    const transcript = readFileSync(cmd.transcript, "utf8");
    mkdirSync(cfg.cacheDir, { recursive: true });
    const cacheDb = await openDatabase(join(cfg.cacheDir, "cache.db"));
    const edb = await provisionExperientialDb(cfg.cacheDir, experientialMigrations, {
      version: VERSION,
    });
    let gwc: GatewayClient | null = null;
    try {
      gwc = createGatewayClient({});
    } catch {
      gwc = null;
    }
    const provider = createEmbeddingProvider(cfg.embeddings);
    try {
      const stats = await inferCitations({
        edb,
        cacheDb,
        transcript,
        ...(cmd.session ? { sessionId: cmd.session } : {}),
        ...(cmd.since !== undefined
          ? { windowMs: [cmd.since, cmd.until ?? Date.now()] as [number, number] }
          : {}),
        embed: (texts) => provider.embed(texts, { input: "query" }),
        judge: gwc ? (r) => gwc.judge(r).then((x) => ({ text: x.text, model: x.model })) : null,
        log: (s) => process.stderr.write(`${s}\n`),
      });
      process.stdout.write(
        `citation-infer: scoped=${stats.scoped} stage1Pass=${stats.stage1Pass} judged=${stats.judged} cited=${stats.cited} parseFailures=${stats.parseFailures}${stats.aborted ? " ABORTED(kill-switch)" : ""}\n`,
      );
    } finally {
      edb.close?.();
      cacheDb.close?.();
    }
    return;
  }

  // THE-249: per-note output-contribution report — cited_in_response credits aggregated per
  // path (top contributors + the dead-retrieved review list), replacing the manual audit.
  if (cmd.kind === "contribution-report") {
    const cfg = resolveOrUsageExit(cmd.input);
    mkdirSync(cfg.cacheDir, { recursive: true });
    const cacheDb = await openDatabase(join(cfg.cacheDir, "cache.db"));
    const edb = await provisionExperientialDb(cfg.cacheDir, experientialMigrations, {
      version: VERSION,
    });
    try {
      const report = contributionReport(edb, cacheDb, {
        ...(cmd.since !== undefined ? { since: cmd.since } : {}),
        ...(cmd.until !== undefined ? { until: cmd.until } : {}),
      });
      const top = report.notes.slice(0, 20);
      const dead = report.notes.filter((n) => n.contributions === 0).slice(0, 20);
      process.stdout.write(
        `contribution-report: ${report.totals.retrievedPaths} retrieved path(s), ` +
          `${report.totals.contributingPaths} contributing, ${report.totals.deadRetrievedPaths} dead-retrieved\n`,
      );
      for (const n of top) {
        process.stdout.write(
          `  ${n.contributions}/${n.retrievals}  ${n.path}${n.callers.length ? ` [${n.callers.join(",")}]` : ""}\n`,
        );
      }
      if (dead.length > 0) {
        process.stdout.write("dead-retrieved (retrieved, never cited):\n");
        for (const n of dead) process.stdout.write(`  0/${n.retrievals}  ${n.path}\n`);
      }
      if (cmd.json) {
        writeFileSync(cmd.json, JSON.stringify(report, null, 2));
        process.stdout.write(`wrote ${cmd.json}\n`);
      }
    } finally {
      edb.close?.();
      cacheDb.close?.();
    }
    return;
  }

  // THE-48: the gap detector — run a batch of queries through the live engine and flag the
  // ones with no real coverage (top-1 below the golden-set-calibrated floor, or too few
  // results). --calibrate replays the golden set and prints the top-1 score distribution.
  if (cmd.kind === "gaps") {
    const cfg = resolveOrUsageExit(cmd.input);
    if (!cmd.queries && !cmd.calibrate) {
      process.stderr.write(
        `gaps requires --queries <file> or --calibrate <golden.yaml>\n\n${USAGE}`,
      );
      process.exit(2);
    }
    mkdirSync(cfg.cacheDir, { recursive: true });
    const cacheDb = await openDatabase(join(cfg.cacheDir, "cache.db"));
    const provider = createEmbeddingProvider(cfg.embeddings);
    const vaultId = cmd.vault ?? cfg.vaults[0]?.id ?? "main";
    const search = async (query: string): Promise<Array<{ path: string; score: number }>> => {
      const [vec] = await provider.embed([query], { input: "query" });
      const results = await graphSearch(cacheDb, {
        query,
        queryVec: vec ?? [],
        vaultId,
        finalTopK: 10,
        ...(cfg.retrieval?.rrfK !== undefined ? { rrfK: cfg.retrieval.rrfK } : {}),
        reranker: null,
      });
      return results.map((r) => ({ path: r.path, score: r.rerank_score }));
    };
    try {
      if (cmd.calibrate) {
        const golden = parseYaml(readFileSync(cmd.calibrate, "utf8")) as {
          queries?: Array<{ id?: string; query_text?: string }>;
        };
        const qs = (golden.queries ?? []).filter((q) => typeof q.query_text === "string");
        const tops: number[] = [];
        for (const q of qs) {
          const hits = await search(q.query_text as string);
          if (hits[0]) tops.push(hits[0].score);
        }
        const d = scoreDistribution(tops);
        process.stdout.write(
          `calibrate (${vaultId}, n=${d.n}): min=${d.min.toFixed(4)} p5=${d.p5.toFixed(4)} p10=${d.p10.toFixed(4)} p25=${d.p25.toFixed(4)} median=${d.median.toFixed(4)}\n` +
            `suggested threshold (p5): ${d.p5.toFixed(4)} (shipped default ${DEFAULT_GAP_THRESHOLD})\n`,
        );
        return;
      }
      const queries = parseQueriesFile(readFileSync(cmd.queries as string, "utf8"));
      const report = await detectGaps(queries, search, {
        ...(cmd.threshold !== undefined ? { threshold: cmd.threshold } : {}),
        ...(cmd.minResults !== undefined ? { minResults: cmd.minResults } : {}),
      });
      process.stdout.write(
        `gaps ${vaultId}: ${report.gaps}/${report.total} below threshold ${report.threshold} (gap rate ${(report.gap_rate * 100).toFixed(1)}%)\n`,
      );
      for (const i of report.items.filter((x) => x.gap)) {
        process.stdout.write(
          `  GAP ${i.id}: "${i.query.slice(0, 80)}" top=${i.top_score?.toFixed(4) ?? "none"} results=${i.results}\n`,
        );
      }
      if (cmd.json) {
        writeFileSync(cmd.json, JSON.stringify(report, null, 2));
        process.stdout.write(`wrote ${cmd.json}\n`);
      }
    } finally {
      cacheDb.close?.();
    }
    return;
  }

  // THE-44/46: the knowledge-health scorecard, computed from the derive layer on demand. The
  // cycle-close session runs this and stamps the result into a vault metrics note; retrieval
  // quality (nDCG/recall) comes from the eval harness and is merged there, not here.
  if (cmd.kind === "metrics") {
    const cfg = resolveOrUsageExit(cmd.input);
    mkdirSync(cfg.cacheDir, { recursive: true });
    const cacheDb = await openDatabase(join(cfg.cacheDir, "cache.db"));
    const edb = await provisionExperientialDb(cfg.cacheDir, experientialMigrations, {
      version: VERSION,
    });
    try {
      const vaultId = cmd.vault ?? cfg.vaults[0]?.id ?? "main";
      const m = vaultMetrics(edb, cacheDb, {
        vaultId,
        nowMs: Date.now(),
        ...(cmd.since !== undefined ? { since: cmd.since } : {}),
        ...(cmd.until !== undefined ? { until: cmd.until } : {}),
        ...(cmd.staleDays !== undefined ? { staleDays: cmd.staleDays } : {}),
      });
      process.stdout.write(
        `metrics ${vaultId}: chunks=${m.totals.chunks} notes=${m.totals.notes} new=${m.totals.new_chunks} retrievals=${m.totals.retrievals} citations=${m.totals.citations}\n` +
          `access: accessed=${m.access.chunks_accessed} stale=${m.access.stale_chunks} never=${m.access.never_accessed_chunks}\n` +
          `linear-linked notes: ${m.linked.notes_with_linear} (${m.linked.distinct_issues} issues)\n`,
      );
      for (const s of m.surfaces) process.stdout.write(`  surface ${s.surface}: ${s.retrievals}\n`);
      for (const t of m.top_notes.slice(0, 10)) {
        process.stdout.write(
          `  ${t.access_count}x ${t.path}${t.citations > 0 ? ` [${t.citations} cited]` : ""}\n`,
        );
      }
      if (cmd.json) {
        writeFileSync(cmd.json, JSON.stringify(m, null, 2));
        process.stdout.write(`wrote ${cmd.json}\n`);
      }
    } finally {
      edb.close?.();
      cacheDb.close?.();
    }
    return;
  }

  // THE-222: sleep-time reflect — the evaluator pass stamps pending agent_episodes eligibility
  // (deterministic rules + optional judge that can only lower) and the gateway-gated preference
  // extraction applies typed deltas to the versioned profile.
  if (cmd.kind === "reflect") {
    const cfg = resolveOrUsageExit(cmd.input);
    mkdirSync(cfg.cacheDir, { recursive: true });
    const edb = await provisionExperientialDb(cfg.cacheDir, experientialMigrations, {
      version: VERSION,
    });
    let gwc: GatewayClient | null = null;
    try {
      gwc = createGatewayClient({});
    } catch {
      gwc = null;
    }
    try {
      const nowMs = Date.now();
      const judge = gwc ? (r: Parameters<GatewayClient["judge"]>[0]) => gwc.judge(r) : null;
      const stats = await evaluateEpisodes(edb, {
        nowMs,
        judge,
        ...(cmd.maxJudged !== undefined ? { maxJudged: cmd.maxJudged } : {}),
      });
      const prefs = await extractPreferences(edb, { judge, nowMs });
      process.stdout.write(
        `reflect: scanned=${stats.scanned} promoted=${stats.promoted} held=${stats.held} denied=${stats.denied} judged=${stats.judged}${stats.judgeAborted ? " JUDGE-ABORTED" : ""}\n` +
          `preferences: ${prefs.skipped ? "skipped (no gateway or no evidence)" : prefs.aborted ? "ABORTED (parse failure)" : `applied=${prefs.applied} version=${prefs.version}`}\n`,
      );
    } finally {
      edb.close?.();
    }
    return;
  }

  // THE-136: anticipatory prefetch — compose vault_context's bootstrap bundle per vault (the
  // same registry surface serve exposes, dispatched as caller "prefetch-worker") and write the
  // prewarm cache. The compose here is always live (no prewarmDir on this registry — this
  // command IS the producer); the serve-path bootstrap reader enforces the TTL + signal hash.
  if (cmd.kind === "prefetch") {
    const cfg = resolveOrUsageExit(cmd.input);
    mkdirSync(cfg.cacheDir, { recursive: true });
    const cacheDb = await openDatabase(join(cfg.cacheDir, "cache.db"));
    const provider = createEmbeddingProvider(cfg.embeddings);
    const pfVaultRegistry = new VaultRegistry(cfg.vaults);
    const memByVault = new Map<string, string>();
    for (const v of cfg.vaults) if (v.memory) memByVault.set(v.id, v.memory.folder);
    const pfRegistry = new ToolRegistry({});
    registerM7Tools(pfRegistry, {
      vaultRegistry: pfVaultRegistry,
      embeddingProvider: provider,
      reranker: null,
      roles: null,
      retrieval: cfg.retrieval,
      classRouter: cfg.retrieval.classRouter,
      memoryFolder: (vaultId) => memByVault.get(vaultId) ?? DEFAULT_MEMORY_FOLDER,
    });
    const ttlHours = cmd.ttlHours ?? 6;
    const targets = cmd.vault ? cfg.vaults.filter((v) => v.id === cmd.vault) : cfg.vaults;
    if (cmd.vault && targets.length === 0) {
      process.stderr.write(`prefetch: unknown vault ${cmd.vault}\n`);
      process.exit(2);
    }
    try {
      for (const v of targets) {
        const res = (await pfRegistry.dispatch(
          "vault_context",
          { vault: v.id },
          {
            caller: "prefetch-worker",
            authenticated: true,
            grantedScopes: new Set(["read:notes"]),
            vaultId: v.id,
            db: cacheDb,
          },
        )) as {
          ok: boolean;
          data?: Record<string, unknown> & {
            signal?: string;
            signal_hash?: string;
            stats?: { chunks_packed?: number };
          };
          error?: { message?: string };
        };
        if (!res.ok || !res.data) {
          process.stdout.write(
            `prefetch ${v.id}: skipped (${res.error?.message ?? "no signal note"})\n`,
          );
          continue;
        }
        const now = Date.now();
        // THE-136 floor: a prefetch that packs nothing writes an empty marker, never a wrong
        // bundle (RRF scores are positional, so emptiness is the enforceable relevance floor).
        const empty = (res.data.stats?.chunks_packed ?? 0) === 0;
        writePrewarm(prewarmPathFor(cfg.cacheDir, v.id), {
          generated_at: now,
          expires_at: now + ttlHours * 3_600_000,
          signal: String(res.data.signal ?? ""),
          signal_hash: String(res.data.signal_hash ?? ""),
          empty,
          ...(empty ? {} : { bundle: res.data }),
        });
        process.stdout.write(
          `prefetch ${v.id}: ${empty ? "empty (floor)" : `${res.data.stats?.chunks_packed} chunk(s)`} ttl=${ttlHours}h\n`,
        );
      }
    } finally {
      cacheDb.close?.();
    }
    return;
  }

  const config = resolveOrUsageExit(cmd.input);
  const configPath = cmd.input ?? process.env.OBSIDIAN_TC_CONFIG;
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
      { version: "20260702_001", sql: notesMigrationSql },
      { version: "20260703_001", sql: vaultEdgesVaultIdMigrationSql },
      { version: "20260709_001", sql: snapshotsMigrationSql },
    ],
    { version: VERSION },
  );
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
  // THE-187/193: serve-side activation lookup for the graph bubble pass — dark unless
  // experiential.activationRerank flips after a ship-rule A/B.
  const activationFor = config.experiential.activationRerank
    ? makeActivationLookup(experientialDb)
    : undefined;
  const experientialOpen = !!(retrievalLog || episodeCapture || activationFor);
  if (!experientialOpen) experientialDb.close?.();

  // Prometheus recorder (G2.4) — always live so get_metrics and the optional /metrics scrape
  // share the same in-memory counters. The scrape endpoint is started below only when
  // observability.prometheus.enabled (default off / `:0`).
  // OTEL tracing (G2.4) — no-op unless observability.otel.endpoint is set.
  const otel = initOtel(config.observability, VERSION);
  const metrics = new MetricsRecorder({
    // THE-197: live idempotency cache size per vault (unexpired, completed rows only).
    idempotencyCacheBytes: () =>
      db
        .prepare(
          "SELECT vault_id AS vault, COALESCE(SUM(result_size), 0) AS value FROM idempotency_keys WHERE completed_at IS NOT NULL AND expires_at > ? GROUP BY vault_id",
        )
        .all(Date.now()) as Array<{ vault: string; value: number }>,
  });
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
  const hasVec = ensureVecChunks(db, embeddingProvider.dimensions, { now: Date.now });
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
  } = {
    reconcile: "pending",
    reconcileAt: null,
    reconcileErrors: [],
    writeFailures: 0,
    notesReady: false,
  };
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
                ...(indexHealth.lastWriteError !== undefined
                  ? { last_write_error: indexHealth.lastWriteError }
                  : {}),
              },
            }
          : {}),
      }),
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

  // THE-291 (part 2): shared index-on-write hooks for the non-M1 writers (m3 periodic, m4
  // tasks, m5 capture, m6 bulk). M1 keeps its identical inline closures from THE-255.
  const reindexHook = (vaultId: string, path: string, content: string): void => {
    void indexNote(
      db,
      embeddingProvider,
      vaultId,
      path,
      content,
      hasVec,
      Date.now,
      makeOnIndexed(vaultId),
      config.embeddings.chunkContext,
    ).catch((e) => {
      indexHealth.writeFailures++;
      indexHealth.lastWriteError = e instanceof Error ? e.message : String(e);
    });
  };
  const deindexHook = (vaultId: string, path: string): void => {
    try {
      deindexNote(db, vaultId, path, hasVec, config.embeddings.chunkContext);
    } catch (e) {
      indexHealth.writeFailures++;
      indexHealth.lastWriteError = e instanceof Error ? e.message : String(e);
    }
  };
  // indexReadable: ACL read-visibility filter shared by the boot reconcile and runtime add_vault.
  const indexReadable = (rel: string): boolean => {
    if (isDefaultDenied(rel)) return false;
    if (acl.readPaths === undefined) return acl.strictReadDefault !== true;
    return acl.readPaths.some((g) => globMatch(g, rel));
  };
  registerM1Tools(registry, {
    vaultRegistry,
    version: VERSION,
    startedAt,
    embeddings: { provider: config.embeddings.provider, model: config.embeddings.model },
    configPath,
    // THE-374: config-gated snapshot-on-write policy (default off).
    snapshots: { enabled: config.snapshots.enabled, retention: config.snapshots.retention },
    // THE-291 (3B): metadata tools read the notes table once the boot notes pass commits.
    metadataIndex: { hasFts, ready: () => indexHealth.notesReady },
    requireCas: config.writes.requireCas,
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
        config.embeddings.chunkContext,
      ).catch((e) => {
        indexHealth.writeFailures++;
        indexHealth.lastWriteError = e instanceof Error ? e.message : String(e);
      });
    },
    deindex: (vaultId, path) => {
      try {
        deindexNote(db, vaultId, path, hasVec, config.embeddings.chunkContext);
      } catch (e) {
        indexHealth.writeFailures++;
        indexHealth.lastWriteError = e instanceof Error ? e.message : String(e);
      }
    },
    // THE-376: runtime add_vault triggers a full index of the newly registered vault
    // (mirrors the boot reconcile below). indexReadable is defined just above.
    indexVault: async (vaultId) => {
      const s = await indexVault({
        db,
        provider: embeddingProvider,
        embed: embedConfig,
        chunkContext: config.embeddings.chunkContext,
        vaultId,
        root: vaultRegistry.resolve(vaultId).root,
        isReadable: indexReadable,
        now: Date.now,
        onIndexed: makeOnIndexed(vaultId),
        onNotesPass: () => {
          indexHealth.notesReady = true;
        },
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
    reindex: reindexHook,
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
    // THE-230: serve-path retrieval logging (experiential.logRetrievals).
    ...(retrievalLog ? { retrievalLog } : {}),
    // THE-406: index_vault must index with the same enrichment as the boot reconcile, or the two
    // paths would re-embed each other's chunks back and forth (the hash covers the enriched text).
    chunkContext: config.embeddings.chunkContext,
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
    // THE-230: serve-path retrieval logging (experiential.logRetrievals).
    ...(retrievalLog ? { retrievalLog } : {}),
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
  });

  // M8 experiential domain (THE-229): work-memory retrieval + management verbs over
  // agent_episodes / chunk_retrievals. With the store closed the tools report unavailable.
  registerM8Tools(registry, {
    ...(experientialOpen ? { edb: experientialDb } : {}),
  });

  // THE-295: acl (+ per-vault overrides) is hoisted above the ToolRegistry construction.

  // stdio is the trusted local transport: the operator runs the binary against
  // their own vault, so calls are authenticated with full local scope.
  const context = (): CallerContext => {
    const active = activeSessions.get("stdio");
    return {
      caller: "stdio",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: firstVault.id,
      db,
      acl,
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
      enableDnsRebindingProtection: config.transports.http.enableDnsRebindingProtection,
      allowedHosts: config.transports.http.allowedHosts,
      allowedOrigins: config.transports.http.allowedOrigins,
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
  void Promise.all(
    config.vaults.map((v) =>
      indexVault({
        db,
        provider: embeddingProvider,
        embed: embedConfig,
        chunkContext: config.embeddings.chunkContext,
        vaultId: v.id,
        root: vaultRegistry.resolve(v.id).root,
        isReadable: indexReadable,
        now: Date.now,
        onIndexed: makeOnIndexed(v.id),
        // THE-291: metadata/FTS readiness is independent of embed success.
        onNotesPass: () => {
          indexHealth.notesReady = true;
        },
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
  ).then((results) => {
    // THE-288: record boot-reconcile health so server_health can surface index degradation
    // instead of the swallowed best-effort failure (per-vault errors are authenticated-only).
    const reconcileErrors = results
      .filter((r) => r.error !== null)
      .map((r) => ({ vault: r.vault, error: r.error as string }));
    indexHealth.reconcile = reconcileErrors.length === 0 ? "ok" : "degraded";
    indexHealth.reconcileAt = Date.now();
    indexHealth.reconcileErrors = reconcileErrors;
    // GH #171: a swallowed boot-reconcile failure presents as a permanent silent stall. Surface it
    // on stderr (not only in-memory indexHealth) so a misconfigured/slow embed backend is diagnosable.
    for (const { vault, error } of reconcileErrors) {
      process.stderr.write(
        `[index] boot reconcile degraded for vault "${vault}": ${error}. ` +
          `The search index may be incomplete; check the embeddings backend ` +
          `(raise embeddings.timeoutMs / lower embeddings.batchSize or embeddings.maxBatchTokens ` +
          `for a slow or small-context local runner).\n`,
      );
    }
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

  // THE-292: periodic cache.db maintenance — purge expired idempotency/elicit rows, trim
  // event_log to its configured retention, PRAGMA optimize. Best-effort and unref'd; expired
  // rows remain lazily rejected on read regardless, so a failed sweep degrades disk
  // reclamation, never correctness.
  const stopMaintenance = config.maintenance.enabled
    ? startMaintenanceSweep({
        db,
        intervalMs: config.maintenance.intervalMinutes * 60_000,
        eventLogDays: config.observability.retention.eventLogDays,
        onSweep: (counts) => {
          const total = counts.idempotency_keys + counts.elicit_tokens + counts.event_log;
          morgiana.emit(firstVault.id, "tc.maintenance.sweep", {
            count: total,
            rows_dropped: { ...counts },
          });
          try {
            writeEvent(db, {
              ts: Date.now(),
              status: "ok",
              event_type: "sweep_run",
              result_size: total,
            });
          } catch {
            /* event_log is best-effort */
          }
        },
        onError: (e) => {
          process.stderr.write(
            `[maintenance] sweep failed: ${e instanceof Error ? e.message : String(e)}\n`,
          );
        },
      })
    : null;

  // THE-296: ambient sleep-time consolidation (weekly synthesis + decision audit) — the
  // scheduling trigger the plane reserved. Starts only when BOTH the flag and the gateway
  // roles are present: the generative jobs degrade without roles, but scheduling them then
  // is pure DB churn. Best-effort; a failed run logs to stderr and never escapes.
  const stopPlane =
    config.plane.enabled && roles
      ? startPlaneScheduler(new SleepTimePlane().register(synthesisJob).register(auditJob), {
          db,
          roles,
          intervalMs: config.plane.intervalMinutes * 60_000,
          onError: (e) =>
            process.stderr.write(
              `[plane] run failed: ${e instanceof Error ? e.message : String(e)}\n`,
            ),
        })
      : null;

  const shutdown = async (): Promise<void> => {
    stopPlane?.();
    stopMaintenance?.();
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

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
