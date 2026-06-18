import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FolderAcl } from "./acl";
import {
  type BridgeClient,
  CapabilityCache,
  buildVaultCapabilities,
  createBridgeClient,
} from "./bridge";
import { loadConfig } from "./config/load";
import { runMigrations } from "./db/migrate";
import { openDatabase } from "./db/open";
import { elicitVerifier } from "./elicit";
import { createEmbeddingProvider } from "./embeddings";
import { type CallerContext, ToolRegistry } from "./mcp/registry";
import { createMcpServer } from "./mcp/server";
import { createPlurClient } from "./plur/client";
import { createHealthTool } from "./tools/admin/health";
import { registerM1Tools } from "./tools/m1";
import { registerM2Tools } from "./tools/m2";
import { registerM3Tools } from "./tools/m3";
import {
  type BridgeTimeouts,
  DEFAULT_BRIDGE_TIMEOUTS,
  type M4Deps,
  bridgeTimeouts,
  openBridge,
  registerM4Tools,
} from "./tools/m4";
import { DEFAULT_MEMORY_FOLDER, DEFAULT_TRACE_FOLDER, registerM5Tools } from "./tools/m5";
import { startHttp } from "./transports/http";
import { connectStdio } from "./transports/stdio";
import { VaultRegistry } from "./vault/registry";

const VERSION = "0.0.0-pre";

// The migration SQL is read relative to this module; the build copies
// src/migrations -> dist/migrations (scripts/copy-assets.mjs) so the bundled
// dist/cli.js resolves it the same way it does from source.
const initialMigrationSql = readFileSync(
  fileURLToPath(new URL("./migrations/20260519_001_initial.sql", import.meta.url)),
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
  runMigrations(db, [{ version: "20260519_001", sql: initialMigrationSql }], { version: VERSION });

  const registry = new ToolRegistry({
    maxResponseBytes: config.governor.maxResponseBytes,
    verifyElicit: elicitVerifier,
  });
  registry.register(
    createHealthTool({ version: VERSION, vaults: config.vaults.map((v) => v.id), startedAt }),
  );
  const vaultRegistry = new VaultRegistry(config.vaults, process.env.OBSIDIAN_TC_DEFAULT_VAULT);
  registerM1Tools(registry, {
    vaultRegistry,
    version: VERSION,
    startedAt,
    embeddings: { provider: config.embeddings.provider, model: config.embeddings.model },
    configPath,
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
  const m4Deps: M4Deps = {
    vaultRegistry,
    capabilities,
    bridgeFor: (vaultId) => bridgeClients.get(vaultId),
    timeouts: (vaultId) => timeoutsByVault.get(vaultId) ?? DEFAULT_BRIDGE_TIMEOUTS,
    commandPolicy: (vaultId) => commandsByVault.get(vaultId) ?? { enabled: false, allowlist: [] },
  };

  const embeddingProvider = createEmbeddingProvider(config.embeddings);
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

  await connectStdio(server);
  process.stderr.write(`obsidian-tc ${VERSION} ready on stdio (vault ${firstVault.id})\n`);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
