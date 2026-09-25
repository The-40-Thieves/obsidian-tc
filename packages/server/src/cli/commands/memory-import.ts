// THE-1124 — `obsidian-tc memory import --from <basic-memory|claude-code-memory> <dir>`.
// Mirrors prefetch.ts's shape: build a throwaway ToolRegistry with the real M1 + M5 tools
// registered, then dispatch through it — every entity/observation/relation write is the exact
// call an MCP client makes (ACL-checked, audited via registry.dispatch's recordOutcome), never a
// direct file write. Dry-run by default (nothing is written); --apply writes.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { version as VERSION } from "../../../package.json";
import { openConfiguredDatabase, openDatabase } from "../../db/open";
import { provisionCacheDb } from "../../db/provision";
import type { CallerContext } from "../../mcp/registry";
import { ToolRegistry } from "../../mcp/registry";
import { applyImport } from "../../memory-import/apply";
import { formatImportReport } from "../../memory-import/format";
import { buildParsedSource } from "../../memory-import/plan";
import { buildAcls } from "../../runtime/acl-build";
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

  // Review finding: print WHERE this run is pointed before doing anything else — dry-run and
  // --apply both write to `cacheDir` (audit rows, `get_entity` reads), and the earlier version of
  // this command silently landed there with no indication, which is how an unset/wrong cacheDir
  // (zero-config mode's home-anchored default in particular) goes unnoticed until someone goes
  // looking for the data it wrote.
  const mode = cmd.apply ? "apply" : "dry-run";
  process.stdout.write(`vault: ${vault.path}  cache: ${cfg.cacheDir}  mode: ${mode}\n`);

  let parsed: ReturnType<typeof buildParsedSource>;
  try {
    parsed = buildParsedSource(cmd.dir, cmd.from);
  } catch (e) {
    // A missing/unreadable/not-a-directory <dir> (walk.ts's assertImportRootUsable) must be a
    // clear top-level failure, never a report that reads like "zero entities, nothing to import".
    process.stderr.write(`memory import: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }

  const cacheDbPath = join(cfg.cacheDir, "cache.db");
  const cacheDbExists = existsSync(cacheDbPath);
  let cacheDb: Awaited<ReturnType<typeof openConfiguredDatabase>>;
  if (cmd.apply || cacheDbExists) {
    mkdirSync(cfg.cacheDir, { recursive: true });
    cacheDb = await openConfiguredDatabase(cfg, "cache.db", { readonly: !cmd.apply });
    // Provisioning (schema migrations) is itself a write — skip it on a read-only dry run against
    // an ALREADY-existing store, which by construction has already been provisioned by whatever
    // `serve`/`--apply` run created it. Only the write path provisions from scratch here.
    if (cmd.apply) provisionCacheDb(cacheDb, { version: VERSION });
  } else {
    // Review finding: a dry run must not CREATE cacheDir when it does not exist yet — there is
    // nothing on disk to read, so every entity below would be created regardless of what a real
    // store might have said, and an ephemeral in-memory database (never touching disk) answers
    // every read the same way an empty real one would.
    process.stdout.write(
      `no cache yet at ${cfg.cacheDir} — first --apply will create it; every entity below would be newly created.\n`,
    );
    cacheDb = await openDatabase(":memory:", cfg.db.busyTimeoutMs);
    provisionCacheDb(cacheDb, { version: VERSION });
  }
  try {
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

    // Review finding: ctx.acl was never set, so every write was checked against `undefined` —
    // enforcePathAcl's own contract for that is UNRESTRICTED (vault/acl-path.ts's
    // evaluatePathAcl: "if (!acl) return { allowed: true, ... }"), which silently ignored a
    // configured `readOnly: true` root or a `writePaths` allowlist. Built the same way
    // runtime/tool-wiring.ts's wireDomainTools and cli/commands/rerun.ts do (buildAcls is the
    // ONE construction site — see runtime/acl-build.ts's own header on why). This ToolRegistry
    // has no `aclResolver`, so a per-call ctx.acl mutation never happens here (mcp/registry/
    // input-binding.ts's applyVaultAcl no-ops without one) — setting it once below is final for
    // every dispatch this command makes.
    const { acl, aclByVault } = buildAcls(cfg.acl, cfg.vaults);
    const ctx: CallerContext = {
      caller: "memory-import-cli",
      authenticated: true,
      grantedScopes: new Set(["read:memory", "write:memory", "read:notes", "write:notes"]),
      vaultId: vault.id,
      db: cacheDb,
      acl: aclByVault.get(vault.id) ?? acl,
    };
    const report = await applyImport(parsed, {
      vault: vault.id,
      adapter: cmd.from,
      applied: !!cmd.apply,
      resume: !!cmd.resume,
      dispatch: (name, input) => registry.dispatch(name, input, ctx),
    });

    process.stdout.write(`${formatImportReport(report)}\n`);
    // Review finding: a collision is just as much a "this run did not do what it looked like it
    // did" outcome as an error — a script that only checks the exit code must see it too.
    if (report.entities.some((e) => e.action === "error" || e.action === "collision"))
      process.exit(1);
  } finally {
    cacheDb.close?.();
  }
}
