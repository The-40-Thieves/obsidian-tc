// THE-1124 — `obsidian-tc memory import --from <basic-memory|claude-code-memory> <dir>`.
// Mirrors prefetch.ts's shape: build a throwaway ToolRegistry with the real M1 + M5 tools
// registered, then dispatch through it — every entity/observation/relation write is the exact
// call an MCP client makes (ACL-checked, audited via registry.dispatch's recordOutcome), never a
// direct file write. Dry-run by default (nothing is written); --apply writes.
import { mkdirSync } from "node:fs";
import { version as VERSION } from "../../../package.json";
import { openConfiguredDatabase } from "../../db/open";
import { provisionCacheDb } from "../../db/provision";
import type { CallerContext } from "../../mcp/registry";
import { ToolRegistry } from "../../mcp/registry";
import { applyImport } from "../../memory-import/apply";
import { formatImportReport } from "../../memory-import/format";
import { buildParsedSource } from "../../memory-import/plan";
import { registerM1Tools } from "../../tools/m1";
import { registerM5Tools } from "../../tools/m5";
import { VaultRegistry } from "../../vault/registry";
import { type Cmd, resolveOrUsageExit } from "../shared";

export async function run_memory_import(cmd: Cmd<"memory-import">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.configPath);

  if (!cmd.from) {
    process.stderr.write("memory import: --from <basic-memory|claude-code-memory> is required\n");
    process.exit(2);
  }
  if (!cmd.dir) {
    process.stderr.write("memory import: a source directory is required\n");
    process.exit(2);
  }
  if (!cmd.vault) {
    process.stderr.write(
      "memory import: --vault <id> is required (imported entities have no source-side vault to infer)\n",
    );
    process.exit(2);
  }
  const vault = cfg.vaults.find((v) => v.id === cmd.vault);
  if (!vault) {
    process.stderr.write(`memory import: unknown vault ${cmd.vault}\n`);
    process.exit(2);
  }

  const parsed = buildParsedSource(cmd.dir, cmd.from);

  mkdirSync(cfg.cacheDir, { recursive: true });
  const cacheDb = await openConfiguredDatabase(cfg, "cache.db");
  try {
    provisionCacheDb(cacheDb, { version: VERSION });
    const vaultRegistry = new VaultRegistry(cfg.vaults);
    const registry = new ToolRegistry({});
    registerM1Tools(registry, {
      vaultRegistry,
      version: VERSION,
      startedAt: Date.now(),
      embeddings: cfg.embeddings,
    });
    registerM5Tools(registry, {
      vaultRegistry,
      cacheDir: cfg.cacheDir,
      memoryFolder: (id) => cfg.vaults.find((v) => v.id === id)?.memory?.folder ?? "memory",
    });

    // Trusted local-operator context, the same posture prefetch.ts documents: no ctx.acl (every
    // vault path is reachable), full read+write:memory/notes so create_entity/add_observation/
    // link_entities/get_entity/read_frontmatter/update_frontmatter all pass their scope check.
    const ctx: CallerContext = {
      caller: "memory-import-cli",
      authenticated: true,
      grantedScopes: new Set(["read:memory", "write:memory", "read:notes", "write:notes"]),
      vaultId: vault.id,
      db: cacheDb,
    };
    const report = await applyImport(parsed, {
      vault: vault.id,
      adapter: cmd.from,
      applied: !!cmd.apply,
      dispatch: (name, input) => registry.dispatch(name, input, ctx),
    });

    process.stdout.write(`${formatImportReport(report)}\n`);
    if (report.entities.some((e) => e.action === "error")) process.exit(1);
  } finally {
    cacheDb.close?.();
  }
}
