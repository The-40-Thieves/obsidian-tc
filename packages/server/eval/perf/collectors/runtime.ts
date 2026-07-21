import { monitorEventLoopDelay } from "node:perf_hooks";
import { deterministicVector } from "../../../src/embeddings/fake";
import { graphSearch } from "../../../src/search/graph_search";
import type { VaultCtx } from "../harness";
import type { MetricSample } from "../report";

/** Family 6 (event-loop delay under load) + 10 (peak RSS per 10k chunks). */
export async function collectRuntime(vault: VaultCtx): Promise<MetricSample[]> {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  let peakRss = process.memoryUsage().rss;
  for (let i = 0; i < 50; i++) {
    await graphSearch(vault.db, {
      query: "vault chunk graph",
      queryVec: deterministicVector("vault chunk graph", 32),
      vaultId: vault.vaultId,
      finalTopK: 10,
    });
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  h.disable();
  const eventloopP99Ms = h.percentile(99) / 1e6; // ns -> ms
  const per10k = vault.chunkCount > 0 ? (peakRss / (1024 * 1024)) * (10000 / vault.chunkCount) : 0;

  return [
    {
      key: "runtime.eventloop_p99_ms",
      value: eventloopP99Ms,
      unit: "ms",
      class: "warn",
      direction: "higher-worse",
    },
    {
      key: "runtime.peak_rss_per_10k_mb",
      value: per10k,
      unit: "count",
      class: "warn",
      direction: "higher-worse",
    },
  ];
}
