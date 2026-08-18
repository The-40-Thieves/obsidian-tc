// THE-636 — `obsidian-tc context-export`. Modelled on cli/commands/forget.ts: real writes to a
// low-trust surface (here, a FILE the operator controls, holding a copy of the experiential
// store) from outside `registry.dispatch`, so the audit_events row is written directly via
// `writeEvent` for the same reason forget.ts's header gives — an operator with shell access
// already outranks the ACL; the thing missing is the RECORD, not the enforcement.
//
// EXPORT IS AN EXFILTRATION SURFACE (ticket item 2): preferences, episode summaries and
// `chunk_retrievals.query_text` are among the most personal derived data this server holds, and
// this is a public repo that has already leaked private vault data once (THE-421). Two guards,
// both hard errors and neither a silent fallback:
//   1. `--out` has NO DEFAULT — an operator must name a destination.
//   2. the resolved `--out` path is refused if it falls inside ANY configured vault's root, so
//      the bundle can never land somewhere `read_note`/the indexer/Obsidian Sync would reach it.
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { version as VERSION } from "../../../package.json";
import type { AuditEvent } from "../../audit";
import { writeEvent } from "../../audit";
import { provisionExperientialDb } from "../../db/experiential";
import { openDatabase } from "../../db/open";
import type { Database } from "../../db/types";
import { exportContextBundle } from "../../experiential/context-bundle";
import { argsHash } from "../../hash";
import { USAGE } from "../args";
import { type Cmd, experientialMigrations, resolveOrUsageExit } from "../shared";

/** True when `outPath` resolves inside `vaultRoot`. Lexical containment via `path.relative` — the
 *  same guard vault/paths.ts's resolveVaultPathChecked uses for the opposite direction (rejecting
 *  a REQUEST path that escapes the vault); here it rejects a DESTINATION path that lands inside
 *  one. No symlink-realpath layer: the destination doesn't need to exist yet (a fresh export
 *  target usually doesn't), so there is nothing on disk to canonicalize through. */
function isInsideVaultRoot(outPath: string, vaultRoot: string): boolean {
  const rel = relative(resolve(vaultRoot), resolve(outPath));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function auditContextExportEvent(
  cacheDb: Database,
  vaultId: string,
  durationMs: number,
  resultSize: number,
): void {
  try {
    const e: AuditEvent = {
      ts: Date.now(),
      vault_id: vaultId,
      tool_name: "context-export",
      caller: "cli-operator",
      duration_ms: durationMs,
      result_size: resultSize,
      status: "ok",
      error_code: null,
      args_hash: argsHash("context-export", { vault: vaultId }),
      event_type: "tool_invocation",
    };
    writeEvent(cacheDb, e);
  } catch (err) {
    // Fail-open, but loud — same posture as forget.ts's auditForgetEvent: the CLI has an operator
    // at the terminal, not a dashboard, so the report goes to stderr.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `warning: context-export completed, but the audit_events row could not be written (${msg}).\n`,
    );
  }
}

export async function run_context_export(cmd: Cmd<"context-export">): Promise<void> {
  const cfg: ServerConfig = resolveOrUsageExit(cmd.input);
  if (!cmd.out) {
    process.stderr.write(`context-export requires --out <path>\n\n${USAGE}`);
    process.exit(2);
  }
  if (cmd.vault && !cfg.vaults.some((v) => v.id === cmd.vault)) {
    process.stderr.write(`context-export: unknown vault ${cmd.vault}\n`);
    process.exit(2);
  }
  const outPath = resolve(cmd.out);
  for (const v of cfg.vaults) {
    if (isInsideVaultRoot(outPath, v.path)) {
      process.stderr.write(
        `context-export: refusing to write inside vault "${v.id}" (${v.path}) — the bundle would be ` +
          `indexed and synced like vault content. Pass --out pointing outside every configured vault.\n`,
      );
      process.exit(1);
    }
  }

  mkdirSync(cfg.cacheDir, { recursive: true });
  const edb = await provisionExperientialDb(cfg.cacheDir, experientialMigrations, {
    version: VERSION,
  });
  const cacheDb = await openDatabase(join(cfg.cacheDir, "cache.db"));
  const t0 = Date.now();
  try {
    const bundle = exportContextBundle(edb, {
      nowMs: t0,
      serverVersion: VERSION,
      ...(cmd.vault ? { vaultId: cmd.vault } : {}),
    });
    const json = JSON.stringify(bundle, null, 2);
    writeFileSync(outPath, json, "utf8");
    // THE-636 item 2: the bundle is derived PII (preferences, episode summaries, retrieval query
    // text) — same PII posture forget.ts's erase mode documents. Printed unconditionally, not
    // gated on a verbosity flag, so it can never be silently skipped.
    process.stderr.write(
      `warning: ${outPath} contains derived personal data (preferences, episode summaries, retrieval query text) — handle and store it accordingly.\n`,
    );
    const rowCount = Object.values(bundle.tables).reduce((n, rows) => n + rows.length, 0);
    process.stdout.write(
      `context-export: wrote ${outPath} (vault=${bundle.vault}, ${rowCount} row(s) across 9 tables)\n`,
    );
    auditContextExportEvent(
      cacheDb,
      cmd.vault ?? "*",
      Date.now() - t0,
      Buffer.byteLength(json, "utf8"),
    );
  } finally {
    edb.close?.();
    cacheDb.close?.();
  }
}
