import { mkdirSync, writeFileSync } from "node:fs";
import { version as VERSION } from "../../../package.json";
import { provisionExperientialDb } from "../../db/experiential";
import { openConfiguredDatabase } from "../../db/open";
import { vaultMetrics } from "../../experiential/metrics";
import { type Cmd, experientialMigrations, resolveOrUsageExit } from "../shared";

export async function run_metrics(cmd: Cmd<"metrics">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.input);
  mkdirSync(cfg.cacheDir, { recursive: true });
  const cacheDb = await openConfiguredDatabase(cfg, "cache.db");
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
