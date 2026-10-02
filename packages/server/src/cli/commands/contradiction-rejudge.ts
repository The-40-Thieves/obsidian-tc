// `obsidian-tc contradiction-rejudge [--dry-run]` — re-judge the open contradiction flags with the
// current gateway judge and record WHICH model ruled. The one-time data fix is in
// plane/contradiction-rejudge.ts (read its header for the why); this is the thin operator shell:
// config + stores + gateway client, dry-run reporting, before/after counts.
//
// CLI-only, deliberately, like `consolidate`: it makes gateway calls over vault content, so an
// agent-callable MCP trigger would be exactly the unattended egress path egress.excludePaths exists
// to keep off the model.
import { mkdirSync } from "node:fs";
import { version as VERSION } from "../../../package.json";
import { provisionExperientialDb } from "../../db/experiential";
import { openConfiguredDatabase } from "../../db/open";
import { provisionCacheDb } from "../../db/provision";
import { createGatewayClient } from "../../gateway";
import {
  planRejudge,
  type RejudgeOptions,
  rejudgeContradictions,
} from "../../plane/contradiction-rejudge";
import { compileEgressFilter } from "../../plane/egress-filter";
import {
  type Cmd,
  experientialMigrations,
  resolveCliVaultIdentity,
  resolveOrUsageExit,
} from "../shared";

const fmt = (m: Record<string, number>): string =>
  Object.keys(m).length === 0
    ? "none"
    : Object.entries(m)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");

export async function run_contradiction_rejudge(cmd: Cmd<"contradiction-rejudge">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.input);
  if (cmd.vault && !cfg.vaults.some((v) => v.id === cmd.vault)) {
    process.stderr.write(`contradiction-rejudge: unknown vault ${cmd.vault}\n`);
    process.exit(2);
  }
  mkdirSync(cfg.cacheDir, { recursive: true });
  const cacheDb = await openConfiguredDatabase(cfg, "cache.db");
  provisionCacheDb(cacheDb, { version: VERSION });
  const edb = await provisionExperientialDb(cfg.cacheDir, experientialMigrations, {
    version: VERSION,
  });
  // Same shared choke point every vault-scoped writer CLI uses: a config `id` rename must be
  // resolved before rows are matched by vault_id (cli/shared.ts).
  resolveCliVaultIdentity(cacheDb, edb, cfg.vaults);
  try {
    const excludeFilter = compileEgressFilter(cfg.egress.excludePaths);
    const opts: RejudgeOptions = {
      ...(cmd.vault !== undefined ? { vaultId: cmd.vault } : {}),
      ...(cmd.judgeModel !== undefined ? { judgeModel: cmd.judgeModel } : {}),
      ...(cmd.limit !== undefined ? { limit: cmd.limit } : {}),
      ...(cmd.concurrency !== undefined ? { concurrency: cmd.concurrency } : {}),
      ...(cmd.delayMs !== undefined ? { delayMs: cmd.delayMs } : {}),
    };

    if (cmd.dryRun) {
      // ZERO gateway calls and ZERO writes: planRejudge is a pure read.
      const { counts } = planRejudge(cacheDb, opts, excludeFilter);
      process.stdout.write(
        "contradiction-rejudge --dry-run: 0 gateway calls made, 0 rows changed\n",
      );
      process.stdout.write(
        `  open=${counts.open} (${fmt(counts.openByVerdict)})\n` +
          `  already_rejudged=${counts.alreadyRejudged} other_judge_model=${counts.otherModel} ` +
          `stale=${counts.stale} excluded=${counts.excluded}\n` +
          `  would_judge=${counts.eligible} (= gateway calls for a real run)\n`,
      );
      return;
    }

    let judge: ReturnType<typeof createGatewayClient>["judge"];
    try {
      judge = createGatewayClient({
        baseUrl: cfg.gateway?.baseUrl,
        token: cfg.gateway?.token,
        excludeFilter,
      }).judge;
    } catch {
      process.stderr.write(
        "contradiction-rejudge: no gateway configured (set gateway.baseUrl or OBSIDIAN_TC_GATEWAY_URL); use --dry-run to see counts without one\n",
      );
      process.exit(1);
    }
    const stats = await rejudgeContradictions(
      { db: cacheDb, judge, now: Date.now, excludeFilter },
      opts,
    );
    process.stdout.write(
      `contradiction-rejudge: judged=${stats.judged} confirmed=${stats.confirmed} ` +
        `dismissed=${stats.dismissed} unjudged=${stats.unjudged} (judge_errors=${stats.judgeErrors})\n` +
        `  skipped: already_rejudged=${stats.alreadyRejudged} other_judge_model=${stats.otherModel} ` +
        `stale=${stats.stale} excluded=${stats.excluded}\n` +
        `  resolved model(s): ${fmt(stats.models)}\n` +
        `  open before: ${stats.open} (${fmt(stats.openByVerdict)})\n` +
        `  open after:  ${Object.values(stats.openByVerdictAfter).reduce((a, b) => a + b, 0)} (${fmt(stats.openByVerdictAfter)})\n`,
    );
    // Unjudged rows were left untouched for a retry — make that a loud, scriptable signal rather
    // than a quiet partial success.
    if (stats.unjudged > 0) {
      process.stderr.write(
        `contradiction-rejudge: ${stats.unjudged} row(s) could not be judged and were left open; re-run to retry them\n`,
      );
      process.exitCode = 1;
    }
  } finally {
    edb.close?.();
    cacheDb.close?.();
  }
}
