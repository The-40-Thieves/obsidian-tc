import { mkdirSync } from "node:fs";
import { version as VERSION } from "../../../package.json";
import { provisionExperientialDb } from "../../db/experiential";
import { recomputeActivation } from "../../experiential/activation";
import { type Cmd, experientialMigrations, resolveOrUsageExit } from "../shared";

export async function run_activation_recompute(cmd: Cmd<"activation-recompute">): Promise<void> {
  const actCfg = resolveOrUsageExit(cmd.input);
  mkdirSync(actCfg.cacheDir, { recursive: true });
  const edb = await provisionExperientialDb(actCfg.cacheDir, experientialMigrations, {
    version: VERSION,
  });
  try {
    const stats = recomputeActivation(edb, Date.now());
    process.stdout.write(`activation recompute: ${stats.chunks} chunk(s) updated\n`);
  } finally {
    edb.close?.();
  }
  return;
}
