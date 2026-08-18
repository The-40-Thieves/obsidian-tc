import { mkdirSync } from "node:fs";
import { version as VERSION } from "../../../package.json";
import { provisionExperientialDb } from "../../db/experiential";
import { evaluateEpisodes, extractPreferences } from "../../experiential/reflect";
import { type Cmd, experientialMigrations, resolveOrUsageExit } from "../shared";

export async function run_reflect(cmd: Cmd<"reflect">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.input);
  mkdirSync(cfg.cacheDir, { recursive: true });
  const edb = await provisionExperientialDb(cfg.cacheDir, experientialMigrations, {
    version: VERSION,
  });
  try {
    const nowMs = Date.now();
    // THE-701 removed the eligibility pass's judge; THE-673 removed extractPreferences' judge too
    // (a deterministic counter over typed evidence, see that file) — this command no longer needs
    // a GatewayClient at all.
    const stats = await evaluateEpisodes(edb, { nowMs });
    // THE-710: the preference plane is partitioned by vault, so extraction fans out per configured
    // vault the way the note-quality job does. Reported PER VAULT rather than summed: a single
    // "applied=N" across vaults would hide that one vault produced everything and another nothing,
    // which is exactly the blend the partition exists to make visible.
    const lines: string[] = [];
    for (const v of cfg.vaults) {
      const prefs = await extractPreferences(edb, v.id, { nowMs });
      lines.push(
        `preferences[${v.id}]: ${
          prefs.skipped
            ? "skipped (no evidence)"
            : `applied=${prefs.applied} version=${prefs.version}`
        }`,
      );
    }
    process.stdout.write(
      `reflect: scanned=${stats.scanned} promoted=${stats.promoted} held=${stats.held} denied=${stats.denied}\n` +
        `${lines.join("\n")}\n`,
    );
  } finally {
    edb.close?.();
  }
  return;
}
