import { mkdirSync } from "node:fs";
import { version as VERSION } from "../../../package.json";
import { provisionExperientialDb } from "../../db/experiential";
import { evaluateEpisodes, extractPreferences } from "../../experiential/reflect";
import { createGatewayClient, type GatewayClient } from "../../gateway";
import { type Cmd, experientialMigrations, resolveOrUsageExit } from "../shared";

export async function run_reflect(cmd: Cmd<"reflect">): Promise<void> {
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
