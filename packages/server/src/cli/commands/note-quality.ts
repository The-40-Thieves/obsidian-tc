import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { version as VERSION } from "../../../package.json";
import { provisionExperientialDb } from "../../db/experiential";
import { openDatabase } from "../../db/open";
import { readNoteQuality, recomputeNoteQuality } from "../../experiential/note-quality";
import { type Cmd, experientialMigrations, resolveOrUsageExit } from "../shared";

// THE-537: recompute the note_quality rollup, then print the flagged notes. An OFFLINE pass — no
// gateway, no inference, no ranking change. Modelled on run_contribution_report (same store
// handling, same finally-close discipline).
export async function run_note_quality(cmd: Cmd<"note-quality">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.input);
  mkdirSync(cfg.cacheDir, { recursive: true });
  const cacheDb = await openDatabase(join(cfg.cacheDir, "cache.db"));
  const edb = await provisionExperientialDb(cfg.cacheDir, experientialMigrations, {
    version: VERSION,
  });
  try {
    const vaults = cmd.vault ? cfg.vaults.filter((v) => v.id === cmd.vault) : cfg.vaults;
    if (cmd.vault && vaults.length === 0) {
      process.stderr.write(`note-quality: unknown vault ${cmd.vault}\n`);
      process.exit(2);
    }
    for (const v of vaults) {
      const stats = recomputeNoteQuality(cacheDb, edb, { vaultId: v.id, nowMs: Date.now() });
      process.stdout.write(
        `note-quality [${v.id}]: ${stats.notes} note(s), ${stats.flagged} flagged, ` +
          // "unscored" is reported separately and prominently: it is NOT a count of bad notes, it
          // is a count of notes there is not yet evidence to judge.
          `${stats.scored} scored, ${stats.unscored} unscored (no usage evidence yet)\n`,
      );
      const rows = readNoteQuality(edb, {
        vaultId: v.id,
        ...(cmd.flags ? { flags: cmd.flags } : {}),
        limit: cmd.limit ?? 20,
      });
      for (const r of rows) {
        const flags = JSON.parse(r.flags) as string[];
        if (flags.length === 0 && !cmd.flags) continue;
        const score = r.quality_score === null ? "  n/a" : r.quality_score.toFixed(3);
        process.stdout.write(`  ${score}  ${r.path}  [${flags.join(",")}]\n`);
      }
    }
  } finally {
    edb.close?.();
    cacheDb.close?.();
  }
}
