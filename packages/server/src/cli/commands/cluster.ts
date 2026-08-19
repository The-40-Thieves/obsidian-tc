import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../db/open";
import { createEmbeddingProvider } from "../../embeddings";
import { createGatewayClient } from "../../gateway";
import { assignClusters } from "../../search/cluster";
import { maybeBuildClusterSummaries } from "../../search/indexing/summarize-clusters";
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
      // THE-628 (second PR): cluster-level (tier-2) summary pass, DARK behind
      // retrieval.summaries.clusters.enabled (default false). Runs HERE, right after this vault's
      // chunk-cluster pass — the designated OFFLINE cadence the cluster plan specifies, not
      // per-write and not inside indexVault: cluster membership over note_summaries embeddings is
      // only meaningful once clustering has actually run. `maybeBuildClusterSummaries` returns null
      // without constructing a gateway client when disabled, so the default config path here makes
      // zero gateway/embed calls. A misconfigured/unreachable gateway must not fail an otherwise-
      // successful chunk-cluster pass — caught and reported, not thrown, mirroring `index`'s
      // handling of the note-level pass (cli/commands/index.ts).
      if (clusterConfig.retrieval.summaries.clusters.enabled) {
        try {
          const embedProvider = createEmbeddingProvider(clusterConfig.embeddings);
          const clusterSummaryStats = await maybeBuildClusterSummaries(
            clusterDb,
            v.id,
            {
              enabled: true,
              maxConcurrency: clusterConfig.retrieval.summaries.clusters.maxConcurrency,
            },
            () =>
              createGatewayClient(
                clusterConfig.retrieval.summaries.model
                  ? { models: { extract: clusterConfig.retrieval.summaries.model } }
                  : {},
              ),
            embedProvider,
          );
          if (clusterSummaryStats) {
            process.stdout.write(
              `cluster: summaries[${v.id}]: ${clusterSummaryStats.summarized} written, ` +
                `${clusterSummaryStats.skipped} unchanged/skipped, ${clusterSummaryStats.failed} failed ` +
                `(${clusterSummaryStats.clusters} cluster(s) over ${clusterSummaryStats.consideredNotes} note summar${clusterSummaryStats.consideredNotes === 1 ? "y" : "ies"})\n`,
            );
          }
        } catch (e) {
          process.stderr.write(
            `cluster: summaries[${v.id}] skipped — ${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
      }
    }
    process.stdout.write(`done: ${total} chunks across ${clusterConfig.vaults.length} vault(s)\n`);
  } finally {
    clusterDb.close?.();
  }
  return;
}
