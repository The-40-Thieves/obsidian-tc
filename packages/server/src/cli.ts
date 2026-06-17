import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config/load";
import { runMigrations } from "./db/migrate";
import { openDatabase } from "./db/open";
import { type CallerContext, ToolRegistry } from "./mcp/registry";
import { createMcpServer } from "./mcp/server";
import { createHealthTool } from "./tools/admin/health";
import { startHttp } from "./transports/http";
import { connectStdio } from "./transports/stdio";

const VERSION = "0.0.0-pre";

// NOTE (release packaging): when bundled to dist/cli.js the migration SQL must
// ship alongside it. For now the bin runs from source under Bun. Tracked for M5.
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

  const registry = new ToolRegistry({ maxResponseBytes: config.governor.maxResponseBytes });
  registry.register(
    createHealthTool({ version: VERSION, vaults: config.vaults.map((v) => v.id), startedAt }),
  );

  // stdio is the trusted local transport: the operator runs the binary against
  // their own vault, so calls are authenticated with full local scope.
  const context = (): CallerContext => ({
    caller: "stdio",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: firstVault.id,
    db,
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
