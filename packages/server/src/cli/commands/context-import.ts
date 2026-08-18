// THE-636 — `obsidian-tc context-import`. Modelled on cli/commands/forget.ts: real writes to the
// experiential store from outside `registry.dispatch`, with the same "audit_events written
// directly via writeEvent" reasoning that file's header gives in full.
//
// IMPORT IS THE DANGEROUS DIRECTION (ticket item 1): a bundle is attacker-supplied data by
// definition. Every row is validated against the CURRENT table schemas (validateContextBundle,
// context-bundle.ts) before this command opens the target store at all — there is no path from a
// malformed bundle to a partial write. `forget wins over import` (item 3) is enforced inside
// `importContextBundle` itself; see that module's header for both directions of the guarantee.
//
// --vault IS LOAD-BEARING (THE-636 review fix, BLOCKER 2a): `remapBundleVault` runs right after
// schema validation and before any store opens — a refusal there (a bundle naming more than one
// source vault under an explicit --vault target) is still a hard error with nothing written, the
// same "no partial write" property the schema-validation gate has.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { version as VERSION } from "../../../package.json";
import type { AuditEvent } from "../../audit";
import { writeEvent } from "../../audit";
import { provisionExperientialDb } from "../../db/experiential";
import { openDatabase } from "../../db/open";
import type { Database } from "../../db/types";
import type { ImportStatsByTable } from "../../experiential/context-bundle";
import {
  importContextBundle,
  remapBundleVault,
  validateContextBundle,
} from "../../experiential/context-bundle";
import { argsHash } from "../../hash";
import { USAGE } from "../args";
import { type Cmd, experientialMigrations, resolveOrUsageExit } from "../shared";

function auditContextImportEvent(
  cacheDb: Database,
  vaultId: string,
  durationMs: number,
  resultSize: number,
): void {
  try {
    const e: AuditEvent = {
      ts: Date.now(),
      vault_id: vaultId,
      tool_name: "context-import",
      caller: "cli-operator",
      duration_ms: durationMs,
      result_size: resultSize,
      status: "ok",
      error_code: null,
      args_hash: argsHash("context-import", { vault: vaultId }),
      event_type: "tool_invocation",
    };
    writeEvent(cacheDb, e);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `warning: context-import completed, but the audit_events row could not be written (${msg}).\n`,
    );
  }
}

function printSummary(stats: ImportStatsByTable, dryRun: boolean): void {
  const label = dryRun ? "would import" : "imported";
  let totalImported = 0;
  let totalDup = 0;
  let totalForgotten = 0;
  let totalUnmatched = 0;
  for (const [table, s] of Object.entries(stats)) {
    totalImported += s.imported;
    totalDup += s.skipped_duplicate;
    totalForgotten += s.skipped_forgotten;
    totalUnmatched += s.skipped_unmatched;
    if (
      s.imported === 0 &&
      s.skipped_duplicate === 0 &&
      s.skipped_forgotten === 0 &&
      s.skipped_unmatched === 0
    )
      continue;
    const parts = [`${s.imported} ${label}`];
    if (s.skipped_duplicate > 0) parts.push(`${s.skipped_duplicate} already present`);
    if (s.skipped_forgotten > 0) parts.push(`${s.skipped_forgotten} forgotten on this install`);
    if (s.skipped_unmatched > 0)
      parts.push(`${s.skipped_unmatched} unmatched (no local chunk — index first, or re-run)`);
    process.stdout.write(`  ${table}: ${parts.join(", ")}\n`);
  }
  process.stdout.write(
    `context-import${dryRun ? " --dry-run" : ""}: ${totalImported} row(s) ${label} across ` +
      `9 table(s); ${totalDup} already present; ${totalForgotten} skipped (forgotten on this ` +
      `install); ${totalUnmatched} skipped (unmatched — no local chunk)\n`,
  );
}

export async function run_context_import(cmd: Cmd<"context-import">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.input);
  if (!cmd.bundlePath) {
    process.stderr.write(`context-import requires a bundle path\n\n${USAGE}`);
    process.exit(2);
  }
  if (cmd.vault && !cfg.vaults.some((v) => v.id === cmd.vault)) {
    process.stderr.write(`context-import: unknown vault ${cmd.vault}\n`);
    process.exit(2);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(cmd.bundlePath, "utf8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`context-import: could not read/parse ${cmd.bundlePath}: ${msg}\n`);
    process.exit(1);
  }

  // THE-636 item 1: schema-validated BEFORE anything opens the target store. No partial write is
  // possible from a malformed bundle because the store handle doesn't exist yet at this point.
  const validated = validateContextBundle(raw);
  if (!validated.ok) {
    process.stderr.write(
      `context-import: ${cmd.bundlePath} is not a valid bundle: ${validated.error}\n`,
    );
    process.exit(1);
  }

  // BLOCKER 2a: still before any store opens. cmd.vault was already checked against cfg.vaults
  // above, so a defined targetVault here is always a real, configured vault on this deployment.
  if (!cmd.vault) {
    // Residual from the THE-636 review: vault ids are conventional labels ("main" everywhere), so
    // verbatim import of a bundle from a DIFFERENT install sharing a vault id silently merges the
    // two installs' rows under one id. There is no cross-install fingerprint to detect that here —
    // the warning is the guard.
    process.stderr.write(
      "context-import: no --vault given — importing verbatim; rows keep the bundle's vault ids. " +
        "If this bundle comes from a DIFFERENT install that shares a vault id with this one, " +
        "their rows will merge indistinguishably; pass --vault <id> to remap into one vault.\n",
    );
  }
  const remapped = remapBundleVault(validated.bundle, cmd.vault);
  if (!remapped.ok) {
    process.stderr.write(`context-import: ${remapped.error}\n`);
    process.exit(1);
  }
  const bundle = remapped.bundle;

  mkdirSync(cfg.cacheDir, { recursive: true });
  const edb = await provisionExperientialDb(cfg.cacheDir, experientialMigrations, {
    version: VERSION,
  });
  const cacheDb = await openDatabase(join(cfg.cacheDir, "cache.db"));
  const t0 = Date.now();
  try {
    const result = importContextBundle(edb, cacheDb, bundle, { dryRun: !!cmd.dryRun });
    printSummary(result.tables, result.dry_run);
    if (!result.dry_run) {
      const resultSize = Buffer.byteLength(JSON.stringify(result.tables), "utf8");
      auditContextImportEvent(cacheDb, cmd.vault ?? bundle.vault, Date.now() - t0, resultSize);
    }
  } finally {
    edb.close?.();
    cacheDb.close?.();
  }
}
