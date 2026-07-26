import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../db/open";
import { assignClusters } from "../../search/cluster";
import { type Cmd, resolveOrUsageExit } from "../shared";

export async function run_cluster(cmd: Cmd<"cluster">): Promise<void> {
  const clusterConfig = resolveOrUsageExit(cmd.input);
  mkdirSync(clusterConfig.cacheDir, { recursive: true });
  const clusterDb = await openDatabase(join(clusterConfig.cacheDir, "cache.db"));
  try {
    let total = 0;
    for (const v of clusterConfig.vaults) {
      const stats = assignClusters(clusterDb, v.id, cmd.k !== undefined ? { k: cmd.k } : {});
      if (stats) {
        total += stats.chunks;
        process.stdout.write(
          `clustered ${v.id}: ${stats.chunks} chunks -> ${stats.k} clusters (${stats.iters} iters)\n`,
        );
      } else {
        process.stdout.write(`clustered ${v.id}: no embedded chunks (run index_vault first)\n`);
      }
    }
    process.stdout.write(`done: ${total} chunks across ${clusterConfig.vaults.length} vault(s)\n`);
  } finally {
    clusterDb.close?.();
  }
  return;
}
