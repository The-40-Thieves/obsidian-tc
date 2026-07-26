import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { version as VERSION } from "../../../package.json";
import { provisionExperientialDb } from "../../db/experiential";
import { openDatabase } from "../../db/open";
import { contributionReport } from "../../experiential/contribution";
import { type Cmd, experientialMigrations, resolveOrUsageExit } from "../shared";

export async function run_contribution_report(cmd: Cmd<"contribution-report">): Promise<void> {
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
