import { mkdirSync } from "node:fs";
import { openConfiguredDatabase } from "../../db/open";
import { createEmbeddingProvider } from "../../embeddings";
import { createGatewayClient } from "../../gateway";
import { compileEgressFilter, EgressViolationError } from "../../plane/egress-filter";
import { assignClusters } from "../../search/cluster";
import { maybeBuildClusterSummaries } from "../../search/indexing/summarize-clusters";
import { type Cmd, resolveOrUsageExit } from "../shared";

export async function run_cluster(cmd: Cmd<"cluster">): Promise<void> {
  const clusterConfig = resolveOrUsageExit(cmd.input);
  mkdirSync(clusterConfig.cacheDir, { recursive: true });
  const clusterDb = await openConfiguredDatabase(clusterConfig, "cache.db");
  // THE-934 fix round 1: egress.excludePaths — a cluster with an excluded-path member is never
  // summarised (see summarize-clusters.ts), and both the gateway and the embedding provider
  // constructed below are guarded at the port.
  const egressFilter = compileEgressFilter(clusterConfig.egress.excludePaths);
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
          const embedProvider = createEmbeddingProvider(clusterConfig.embeddings, {
            excludeFilter: egressFilter,
          });
          const clusterSummaryStats = await maybeBuildClusterSummaries(
            clusterDb,
            v.id,
            {
              enabled: true,
              maxConcurrency: clusterConfig.retrieval.summaries.clusters.maxConcurrency,
            },
            () =>
              createGatewayClient({
                ...(clusterConfig.retrieval.summaries.model
                  ? { models: { extract: clusterConfig.retrieval.summaries.model } }
                  : {}),
                excludeFilter: egressFilter,
              }),
            embedProvider,
            egressFilter,
          );
          if (clusterSummaryStats) {
            process.stdout.write(
              `cluster: summaries[${v.id}]: ${clusterSummaryStats.summarized} written, ` +
                `${clusterSummaryStats.skipped} unchanged/skipped, ${clusterSummaryStats.failed} failed, ` +
                `${clusterSummaryStats.gced} superseded GC'd ` +
                `(${clusterSummaryStats.clusters} cluster(s) over ${clusterSummaryStats.consideredNotes} ${clusterSummaryStats.consideredNotes === 1 ? "note summary" : "note summaries"})\n`,
            );
          }
        } catch (e) {
          // THE-934 fix round 2 (N1): mirrors index.ts's handling of the note-level pass -- an
          // EgressViolationError means the port guard caught what summarize-clusters.ts's own
          // pre-filter should already have dropped, a broken security invariant rather than an
          // operational hiccup, so it propagates and fails the run instead of being folded into
          // this warning line.
          if (e instanceof EgressViolationError) throw e;
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
