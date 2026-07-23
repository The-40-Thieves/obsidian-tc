import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { parse as parseYaml } from "yaml";
import { version as VERSION } from "../package.json";
import { FolderAcl, makeIndexReadable, makeReindexGate } from "./acl";
import { writeEvent } from "./audit";
import {
  type BridgeClient,
  bridgeState,
  buildVaultCapabilities,
  CapabilityCache,
  checkBridgeCompat,
  createBridgeClient,
  formatCompatWarning,
  type RestApiOnDisk,
} from "./bridge";
import { resolveCapabilityProfile } from "./capability";
import { parseCliArgs, redactConfig, resolveServeConfig, USAGE } from "./cli/args";
import { installPlugin } from "./cli/plugin-install";
import { provisionExperientialDb } from "./db/experiential";
import { registerMaintenanceSweep } from "./db/maintenance";
import { openDatabase } from "./db/open";
import { provisionCacheDb } from "./db/provision";
import { assembleDoctorReport, renderText } from "./doctor";
import { elicitVerifier, setDefaultElicitTtlSeconds } from "./elicit";
import { createEmbeddingProvider } from "./embeddings";
import {
  makeActivationLookup,
  recomputeActivation,
  registerActivationRecompute,
} from "./experiential/activation";
import { inferCitations } from "./experiential/citation";
import { contributionReport } from "./experiential/contribution";
import { createEpisodeCapture } from "./experiential/episodes";
import { forgetEpisode, forgetNote, verifyForgetLog } from "./experiential/forget";
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
import { buildModelTierReranker } from "./model";
import { MorgianaEmitter } from "./morgiana/emitter";
import { initOtel } from "./otel/tracing";
import type { GatewayRoles } from "./plane/gateway";
import { auditJob } from "./plane/jobs/audit";
import { makeContradictionDrainer } from "./plane/jobs/contradiction-drain";
import { synthesisJob } from "./plane/jobs/synthesis";
import { registerPlaneScheduler, SleepTimePlane } from "./plane/plane";
import { createPlurBackend } from "./plur/client";
import { Scheduler } from "./scheduler/scheduler";
import { assignClusters } from "./search/cluster";
import { runLlmDensify } from "./search/densify-runner";
import { ensureNotesFts } from "./search/fts";
import { graphSearch } from "./search/graph_search";
import { IndexCoordinator } from "./search/index-coordinator";
import {
  deindexNote,
  type IndexedChunk,
  type IndexHook,
  indexNote,
  indexVault,
} from "./search/indexer";
import { nativeLoaded } from "./search/native";
import { prewarmPathFor, writePrewarm } from "./search/prefetch";
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
// THE-239: the hash-chained forget audit log (dependency-aware deletion).
const forgetLogMigrationSql = readFileSync(
  fileURLToPath(new URL("./migrations/20260712_003_forget_log.sql", import.meta.url)),
  "utf8",
);
// THE-461: one-row watermark for the incremental ACT-R activation recompute.
const activationWatermarkMigrationSql = readFileSync(
  fileURLToPath(new URL("./migrations/20260723_001_activation_watermark.sql", import.meta.url)),
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
  { version: "20260712_003", sql: forgetLogMigrationSql },
  { version: "20260723_001", sql: activationWatermarkMigrationSql },
];
type Cmd<K extends string> = Extract<ReturnType<typeof parseCliArgs>, { kind: K }>;

function resolveOrUsageExit(input?: string): ServerConfig {
  try {
    return resolveServeConfig(input);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    process.exit(2);
  }
}

async function run_version(_cmd: Cmd<"version">): Promise<void> {
  process.stdout.write(`${VERSION}\n`);
  return;
}

async function run_help(_cmd: Cmd<"help">): Promise<void> {
  process.stdout.write(USAGE);
  return;
}

async function run_error(cmd: Cmd<"error">): Promise<void> {
  process.stderr.write(`${cmd.message}\n\n${USAGE}`);
  process.exit(2);
}

async function run_plugin_install(cmd: Cmd<"plugin-install">): Promise<void> {
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

async function run_config_show(cmd: Cmd<"config-show" | "config-validate">): Promise<void> {
  const resolved = resolveOrUsageExit(cmd.configPath);
  process.stdout.write(
    cmd.kind === "config-show"
      ? `${JSON.stringify(redactConfig(resolved), null, 2)}\n`
      : "config valid\n",
  );
  return;
}

// THE-523: derive the Local REST API plugin's on-disk state for a vault from the THE-522 capability
// profile — absent / disabled / enabled — so bridgeState can distinguish "cannot" from "will not".
// Returns undefined when the vault was not detected on disk (nothing to say).
function restApiOnDisk(
  profile: Awaited<ReturnType<typeof resolveCapabilityProfile>>,
  vaultPath: string,
): RestApiOnDisk | undefined {
  const vault = profile.obsidian.vaults.find((v) => v.path === vaultPath);
  if (!vault) return undefined;
  const plugin = vault.plugins.installed.find((p) => p.id === "obsidian-local-rest-api");
  if (!plugin) return "absent";
  return plugin.enabled ? "enabled" : "disabled";
}

// THE-521 — runtime health probe. Loads config, detects the environment (THE-522), runs the default
// check set, and emits either the versioned JSON envelope or human text rendered from it. Exits
// non-zero when any check fails, so scripts and CI can gate on health — a warning does not fail.
async function run_doctor(cmd: Cmd<"doctor">): Promise<void> {
  const config = resolveOrUsageExit(cmd.configPath);
  // Include the configured vault paths so they appear even when the desktop registry is absent
  // (headless/server boxes), which is exactly where doctor is most useful.
  const profile = await resolveCapabilityProfile({
    extraVaultPaths: config.vaults.map((v) => v.path),
  });

  // THE-523 bridge.state: probe each vault's companion live, then resolve state using the THE-522
  // on-disk detection so "cannot vs will not" is distinguished (absent / disabled / enabled-but-
  // unreachable). Probing never throws — a vault with no endpoint resolves to headless.
  const bridgeReports = await Promise.all(
    config.vaults.map(async (v) => {
      const client = v.restApiUrl
        ? createBridgeClient({
            baseUrl: v.restApiUrl,
            apiKey: v.restApiKey,
            timeoutMs: v.bridges?.timeoutMs,
          })
        : undefined;
      const snap = await buildVaultCapabilities(client, {
        probeSkip: v.plugins?.probeSkip,
        forceEnabled: v.plugins?.forceEnabled,
        forceDisabled: v.plugins?.forceDisabled,
        timeoutMs: v.bridges?.probeTimeoutMs,
      });
      return {
        vaultId: v.id,
        report: bridgeState(snap, { restApiOnDisk: restApiOnDisk(profile, v.path) }),
      };
    }),
  );

  const report = await assembleDoctorReport({
    config: {
      auth: {
        mode: config.auth.mode,
        tokenTtlSeconds: config.auth.tokenTtlSeconds,
        readOnly: config.acl.readOnly,
      },
    },
    profile,
    bridgeReports,
    ...(cmd.token !== undefined ? { token: cmd.token } : {}),
  });

  process.stdout.write(
    cmd.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderText(report)}\n`,
  );
  if (report.overallStatus === "fail") process.exit(1);
}

async function run_cluster(cmd: Cmd<"cluster">): Promise<void> {
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
    process.stdout.write(`done: ${total} chunks across ${clusterConfig.vaults.length} vault(s)\n`);
  } finally {
    clusterDb.close?.();
  }
  return;
}

async function run_activation_recompute(cmd: Cmd<"activation-recompute">): Promise<void> {
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

async function run_densify_llm(cmd: Cmd<"densify-llm">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.input);
  // retrieval.densify.llmEdges is the off-switch for the LLM edge layer — the one code path that sends
  // note CONTENT to a model. It is checked FIRST: before the cache db is opened, before a gateway
  // client is built. It used to be checked last, so the gateway-missing error fired ahead of it and an
  // operator on a host with no gateway was told the wrong thing entirely — never learning the feature
  // was simply disabled. A safety gate that only fires once the unsafe machinery is already set up is a
  // gate in name only.
  if (cfg.retrieval?.densify?.llmEdges !== true) {
    process.stderr.write(
      "densify-llm is disabled: set retrieval.densify.llmEdges = true in your config to enable it.\n" +
        "It sends note content to the configured model (local gateway by default), so it is opt-in.\n",
    );
    process.exit(2);
  }
  mkdirSync(cfg.cacheDir, { recursive: true });
  const cacheDb = await openDatabase(join(cfg.cacheDir, "cache.db"));
  let gwc: GatewayClient | null = null;
  try {
    gwc = createGatewayClient({});
  } catch {
    gwc = null;
  }
  if (!gwc) {
    process.stderr.write(
      "densify-llm requires a configured inference gateway (extract role -> local model); none resolved.\n",
    );
    cacheDb.close?.();
    process.exit(2);
  }
  const floor = cfg.retrieval?.densify?.confidenceFloor;
  try {
    const vaultIds = cmd.vault ? [cmd.vault] : cfg.vaults.map((v) => v.id);
    for (const vid of vaultIds) {
      const res = await runLlmDensify(cacheDb, vid, gwc, {
        ...(floor !== undefined ? { confidenceFloor: floor } : {}),
      });
      process.stdout.write(`densify-llm[${vid}]: notes=${res.notes} edges=${res.edges}\n`);
    }
  } finally {
    cacheDb.close?.();
  }
  return;
}

async function run_citation_infer(cmd: Cmd<"citation-infer">): Promise<void> {
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

async function run_contribution_report(cmd: Cmd<"contribution-report">): Promise<void> {
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

async function run_forget(cmd: Cmd<"forget">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.input);
  if (!cmd.episode && !cmd.note && !cmd.verify) {
    process.stderr.write(
      `forget requires --episode <id>, --note <rel-path>, or --verify\n\n${USAGE}`,
    );
    process.exit(2);
  }
  mkdirSync(cfg.cacheDir, { recursive: true });
  const edb = await provisionExperientialDb(cfg.cacheDir, experientialMigrations, {
    version: VERSION,
  });
  const cacheDb = await openDatabase(join(cfg.cacheDir, "cache.db"));
  try {
    if (cmd.verify) {
      const v = verifyForgetLog(edb);
      process.stdout.write(
        v.ok
          ? `forget-log OK: ${v.entries} entr${v.entries === 1 ? "y" : "ies"}, chain intact\n`
          : `forget-log BROKEN at seq ${v.breakAt} (${v.entries} entries)\n`,
      );
      if (!v.ok) process.exit(1);
      return;
    }
    const vaultId = cmd.vault ?? cfg.vaults[0]?.id ?? "main";
    if (cmd.episode) {
      const r = forgetEpisode(edb, cmd.episode, {
        nowMs: Date.now(),
        ...(cmd.erase ? { erase: true } : {}),
      });
      if (!r.found) {
        process.stderr.write(`forget: episode ${cmd.episode} not found\n`);
        process.exit(1);
      }
      process.stdout.write(
        `forgot episode ${cmd.episode} (${cmd.erase ? "erase" : "tombstone"})${r.already_blocked ? " [was already blocked]" : ""}` +
          `${r.scrubbed_fields > 0 ? " content scrubbed" : ""}` +
          `${r.preference_evidence_mentions > 0 ? `; NOTE: ${r.preference_evidence_mentions} preference-delta evidence mention(s) (append-only, review manually)` : ""}\n`,
      );
      return;
    }
    const rel = (cmd.note as string).replace(/\\/g, "/");
    const vault = cfg.vaults.find((v) => v.id === vaultId);
    const abs = vault ? join(vault.path, rel) : null;
    if (abs && existsSync(abs)) {
      process.stderr.write(
        `forget: ${rel} still exists in the vault — delete the note first (delete_note or file manager), then forget propagates the derived state\n`,
      );
      process.exit(1);
    }
    const memFolder = vault?.memory?.folder ?? DEFAULT_MEMORY_FOLDER;
    const r = forgetNote(edb, cacheDb, {
      vaultId,
      relPath: rel,
      nowMs: Date.now(),
      ...(cmd.erase ? { erase: true } : {}),
      prewarmDir: cfg.cacheDir,
      ...(vault ? { vaultRoot: vault.path, memoryFolder: memFolder } : {}),
    });
    process.stdout.write(
      `forgot note ${rel} (${cmd.erase ? "erase" : "tombstone"}): ${r.chunk_ids.length} chunk(s), ` +
        `retrievals ${cmd.erase ? `${r.retrieval_rows_deleted} deleted` : `${r.retrieval_rows} kept (audit)`}, ` +
        `${r.activation_rows_deleted} activation row(s) cleared` +
        `${r.prewarm_invalidated ? ", prewarm cache invalidated" : ""}\n`,
    );
    if (r.outdated_reflections.length > 0)
      process.stdout.write(
        `  outdated reflections (review): ${r.outdated_reflections.join(", ")}\n`,
      );
    if (r.syntheses_mentions > 0 || r.contradictions_mentions > 0)
      process.stdout.write(
        `  report-only: ${r.syntheses_mentions} synthesis row(s), ${r.contradictions_mentions} contradiction row(s) mention this path (they regenerate / are lifecycle-owned)\n`,
      );
    if (r.chunk_ids.length > 0)
      process.stdout.write(
        `  note: ${r.chunk_ids.length} chunk(s) still in the search index — run the server (boot reconcile deindexes deleted notes) or index_vault to finish\n`,
      );
  } finally {
    edb.close?.();
    cacheDb.close?.();
  }
  return;
}

async function run_gaps(cmd: Cmd<"gaps">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.input);
  if (!cmd.queries && !cmd.calibrate) {
    process.stderr.write(`gaps requires --queries <file> or --calibrate <golden.yaml>\n\n${USAGE}`);
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
      model: provider.id, // THE-530: constrain seeds to the active model
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

async function run_metrics(cmd: Cmd<"metrics">): Promise<void> {
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

async function run_reflect(cmd: Cmd<"reflect">): Promise<void> {
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

async function run_prefetch(cmd: Cmd<"prefetch">): Promise<void> {
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
    ranking: cfg.ranking,
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
    { now: Date.now },
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
    /** THE-457: chunks dropped from the bounded contradiction queue under backpressure. */
    contradictionsDropped: number;
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
    contradictionsDropped: 0,
    auditWriteFailures: 0,
    indexQueueBackpressures: 0,
    lastChunksUpserted: null,
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
                contradictions_dropped: indexHealth.contradictionsDropped,
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
  // only enqueue when roles are present; the queue is drained best-effort after the boot reconcile.
  const contradictionQueue: Array<{ vaultId: string; chunk: IndexedChunk }> = [];
  // THE-457: bound the queue (an unbounded runtime write stream must not grow it without limit) and
  // count drops for the health signal.
  const CONTRADICTION_QUEUE_MAX = 5000;
  const CONTRADICTION_DRAIN_BATCH = 100;
  const CONTRADICTION_DRAIN_MS = 15_000;
  // THE-457: cap on how long graceful shutdown waits for in-flight index + contradiction work.
  const SHUTDOWN_DRAIN_MS = 5000;
  const makeOnIndexed = (vaultId: string): IndexHook | undefined =>
    roles
      ? (chunks) => {
          for (const c of chunks) {
            if (contradictionQueue.length >= CONTRADICTION_QUEUE_MAX) {
              indexHealth.contradictionsDropped++;
              continue;
            }
            contradictionQueue.push({ vaultId, chunk: c });
          }
        }
      : undefined;
  // THE-457/THE-458 (audit #6): continuous, single-flight, bounded contradiction drain. The boot sweep
  // drained the queue ONCE; post-boot, runtime index-on-write kept enqueuing with no drain, so the
  // queue grew unbounded and runtime writes received no contradiction analysis. makeContradictionDrainer
  // drains one bounded batch at a time (deduped by (vault, chunk)); its in-flight batch is a PROMISE
  // (drainer.inFlight), so shutdown can await a live batch instead of racing db.close() against it.
  const contradictionDrainer = makeContradictionDrainer({
    db,
    roles,
    queue: contradictionQueue,
    batchSize: CONTRADICTION_DRAIN_BATCH,
    model: embeddingProvider.id, // THE-530: constrain neighbor discovery to the active model
    now: Date.now,
    onError: (e) => {
      indexHealth.writeFailures++;
      indexHealth.lastWriteError = e instanceof Error ? e.message : String(e);
    },
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
        ),
      delete: (vaultId, path) =>
        deindexNote(db, vaultId, path, hasVec, config.embeddings.chunkContext),
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
    // THE-455: M1 shares the coordinator-backed hooks (was an identical inline indexNote/deindexNote).
    reindex: reindexHook,
    deindex: deindexHook,
    // THE-376: runtime add_vault triggers a full index of the newly registered vault
    // (mirrors the boot reconcile below). indexReadableFor is defined just above.
    indexVault: async (vaultId) => {
      const s = await indexVault({
        db,
        provider: embeddingProvider,
        embed: embedConfig,
        chunkContext: config.embeddings.chunkContext,
        densify: config.retrieval.densify,
        vaultId,
        root: vaultRegistry.resolve(vaultId).root,
        isReadable: indexReadableFor(vaultId),
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
    onIndexVaultComplete: (_vaultId, stats) => {
      indexHealth.lastChunksUpserted = stats.chunks_upserted;
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
      // THE-520: without this the auth_rejections_total counter exists but is never incremented,
      // so a token refused at the edge stays invisible to /metrics.
      metrics,
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
        densify: config.retrieval.densify,
        vaultId: v.id,
        root: vaultRegistry.resolve(v.id).root,
        isReadable: indexReadableFor(v.id),
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
  ).then(async (results) => {
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
    // THE-458 (audit #6): sweep chunks enqueued during the boot reconcile through the SAME bounded,
    // single-flight worker as runtime writes (was a fire-and-forget, unbounded splice(0) that ran the
    // whole queue at once and bypassed the batch limit + single-flight guard). No-op without the
    // gateway (roles null -> queue stays empty). Fire-and-forget by design (boot does not block on it),
    // but now deduped with the interval worker so the two cannot double-process the same chunk.
    if (!roles) return;
    await contradictionDrainer.drainToEmpty();
  });

  morgiana.emit(firstVault.id, "tc.server.start");

  // THE-462: ONE unref'd background scheduler folds the four formerly-independent setInterval
  // timers (maintenance sweep, plane consolidation, activation recompute, contradiction drain) into
  // a single tick loop. Each job keeps its exact run body and error/skip routing; the scheduler adds
  // shared single-flight and durable last-success/next-run (job_schedule in cache.db). Its clock is
  // Date.now for durable timestamps only. Budget deferral (event-loop-delay awareness) is available
  // but left disabled here (eventLoopDeferMs unset) to preserve today's cadence — enabling it is a
  // config-tuning follow-up.
  const scheduler = new Scheduler({ now: Date.now, db });

  // THE-292: periodic cache.db maintenance — purge expired idempotency/elicit rows, trim
  // event_log to its configured retention, PRAGMA optimize. Best-effort; expired rows remain
  // lazily rejected on read regardless, so a failed sweep degrades disk reclamation, never
  // correctness.
  if (config.maintenance.enabled) {
    registerMaintenanceSweep(scheduler, {
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
    });
  }

  // THE-296: ambient sleep-time consolidation (weekly synthesis + decision audit). Registered only
  // when BOTH the flag and the gateway roles are present: the generative jobs degrade without roles,
  // but scheduling them then is pure DB churn. Best-effort; a failed run logs to stderr.
  if (config.plane.enabled && roles) {
    registerPlaneScheduler(
      scheduler,
      new SleepTimePlane().register(synthesisJob).register(auditJob),
      {
        db,
        roles,
        intervalMs: config.plane.intervalMinutes * 60_000,
        onError: (e) =>
          process.stderr.write(
            `[plane] run failed: ${e instanceof Error ? e.message : String(e)}\n`,
          ),
      },
    );
  }

  // THE-227/228: keep cached_activation_score warm as capture accrues. recomputeActivation is
  // otherwise CLI-only, so on serve the activation state would freeze at whatever a manual run
  // left, stale the moment new retrievals land. Registered only while the experiential store is open
  // (capture on); idempotent, no gateway, best-effort. Reuses the maintenance cadence.
  if (experientialOpen) {
    registerActivationRecompute(scheduler, {
      edb: experientialDb,
      intervalMs: config.maintenance.intervalMinutes * 60_000,
      onError: (e) =>
        process.stderr.write(
          `[activation-recompute] ${e instanceof Error ? e.message : String(e)}\n`,
        ),
    });
  }

  // THE-457/THE-462: continuous contradiction drain worker, folded into the unified scheduler.
  // contradictionDrainer keeps its own single-flight guard; the scheduler's single-flight wraps it
  // harmlessly (idempotent). Registered only when the gateway is configured (the drainer is a no-op
  // without roles).
  if (roles) {
    scheduler.register({
      name: "contradiction-drain",
      intervalMs: CONTRADICTION_DRAIN_MS,
      run: (signal) => contradictionDrainer.drainOnce(signal),
    });
  }

  scheduler.start();

  const shutdown = async (): Promise<void> => {
    // THE-462: one bounded stop replaces the four stop functions — clears the timer, aborts the
    // in-flight run's AbortSignal, and awaits settle under the scheduler's deadline.
    await scheduler.stop();
    morgiana.emit(firstVault.id, "tc.server.shutdown");
    // THE-457: drain in-flight work under a bounded deadline before exit, so a write mid-index isn't
    // lost and SQLite closes cleanly. Never hang — race the drain against a timeout.
    await Promise.race([
      (async () => {
        await indexCoordinator.idle().catch(() => {});
        // THE-458 (audit #6): AWAIT any in-flight contradiction batch before touching the DB (the old
        // boolean guard made this call return immediately, so db.close() below could race a live
        // checkContradictions write), then run one final bounded batch for residual work.
        await contradictionDrainer.inFlight?.catch(() => {});
        await contradictionDrainer.drainOnce().catch(() => {});
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

async function main(): Promise<void> {
  const cmd = parseCliArgs(process.argv.slice(2));
  switch (cmd.kind) {
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
