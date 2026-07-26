import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { version as VERSION } from "../../../package.json";
import { provisionExperientialDb } from "../../db/experiential";
import { openDatabase } from "../../db/open";
import { forgetEpisode, forgetNote, verifyForgetLog } from "../../experiential/forget";
import { DEFAULT_MEMORY_FOLDER } from "../../tools/m5";
import { USAGE } from "../args";
import { type Cmd, experientialMigrations, resolveOrUsageExit } from "../shared";

export async function run_forget(cmd: Cmd<"forget">): Promise<void> {
  const cfg = resolveOrUsageExit(cmd.input);
  if (!cmd.episode && !cmd.note && !cmd.verify) {
    process.stderr.write(
      `forget requires --episode <id>, --note <rel-path>, or --verify\n\n${USAGE}`,
    );
    process.exit(2);
  }
  mkdirSync(cfg.cacheDir, { recursive: true });
  const edb = await provisionExperientialDb(cfg.cacheDir, experientialMigrations, {
    version: VERSION,
  });
  const cacheDb = await openDatabase(join(cfg.cacheDir, "cache.db"));
  try {
    if (cmd.verify) {
      const v = verifyForgetLog(edb);
      process.stdout.write(
        v.ok
          ? `forget-log OK: ${v.entries} entr${v.entries === 1 ? "y" : "ies"}, chain intact\n`
          : `forget-log BROKEN at seq ${v.breakAt} (${v.entries} entries)\n`,
      );
      if (!v.ok) process.exit(1);
      return;
    }
    const vaultId = cmd.vault ?? cfg.vaults[0]?.id ?? "main";
    if (cmd.episode) {
      const r = forgetEpisode(edb, cmd.episode, {
        nowMs: Date.now(),
        ...(cmd.erase ? { erase: true } : {}),
      });
      if (!r.found) {
        process.stderr.write(`forget: episode ${cmd.episode} not found\n`);
        process.exit(1);
      }
      process.stdout.write(
        `forgot episode ${cmd.episode} (${cmd.erase ? "erase" : "tombstone"})${r.already_blocked ? " [was already blocked]" : ""}` +
          `${r.scrubbed_fields > 0 ? " content scrubbed" : ""}` +
          `${r.preference_evidence_mentions > 0 ? `; NOTE: ${r.preference_evidence_mentions} preference-delta evidence mention(s) (append-only, review manually)` : ""}\n`,
      );
      return;
    }
    const rel = (cmd.note as string).replace(/\\/g, "/");
    const vault = cfg.vaults.find((v) => v.id === vaultId);
    const abs = vault ? join(vault.path, rel) : null;
    if (abs && existsSync(abs)) {
      process.stderr.write(
        `forget: ${rel} still exists in the vault — delete the note first (delete_note or file manager), then forget propagates the derived state\n`,
      );
      process.exit(1);
    }
    const memFolder = vault?.memory?.folder ?? DEFAULT_MEMORY_FOLDER;
    const r = forgetNote(edb, cacheDb, {
      vaultId,
      relPath: rel,
      nowMs: Date.now(),
      ...(cmd.erase ? { erase: true } : {}),
      prewarmDir: cfg.cacheDir,
      ...(vault ? { vaultRoot: vault.path, memoryFolder: memFolder } : {}),
    });
    process.stdout.write(
      `forgot note ${rel} (${cmd.erase ? "erase" : "tombstone"}): ${r.chunk_ids.length} chunk(s), ` +
        `retrievals ${cmd.erase ? `${r.retrieval_rows_deleted} deleted` : `${r.retrieval_rows} kept (audit)`}, ` +
        `${r.activation_rows_deleted} activation row(s) cleared` +
        `${r.prewarm_invalidated ? ", prewarm cache invalidated" : ""}\n`,
    );
    if (r.outdated_reflections.length > 0)
      process.stdout.write(
        `  outdated reflections (review): ${r.outdated_reflections.join(", ")}\n`,
      );
    if (r.syntheses_mentions > 0 || r.contradictions_mentions > 0)
      process.stdout.write(
        `  report-only: ${r.syntheses_mentions} synthesis row(s), ${r.contradictions_mentions} contradiction row(s) mention this path (they regenerate / are lifecycle-owned)\n`,
      );
    if (r.chunk_ids.length > 0)
      process.stdout.write(
        `  note: ${r.chunk_ids.length} chunk(s) still in the search index — run the server (boot reconcile deindexes deleted notes) or index_vault to finish\n`,
      );
  } finally {
    edb.close?.();
    cacheDb.close?.();
  }
  return;
}
