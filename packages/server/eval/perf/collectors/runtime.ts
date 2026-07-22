import { monitorEventLoopDelay } from "node:perf_hooks";
import { deterministicVector } from "../../../src/embeddings/fake";
import { graphSearch } from "../../../src/search/graph_search";
import type { VaultCtx } from "../harness";
import type { MetricSample } from "../report";

/** Family 6 (event-loop delay under load) + 10 (peak resident memory during the run). */
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
  // THE-459: report peak RSS as measured, in MB.
  //
  // This previously extrapolated to a "per 10k chunks" figure:
  //   (peakRss / MB) * (10000 / vault.chunkCount)
  // peakRss is WHOLE-PROCESS resident memory — harness, DB connection, module graph, every other
  // vault — so dividing it by one vault's chunk count attributed all of it to those chunks and
  // moved whenever anything unrelated in the process allocated. The number did not measure what
  // its name claimed, and it was additionally tagged unit:"count" while holding megabytes.
  //
  // Not normalized per-chunk at all now: scenarios are fixed-size and deterministically seeded,
  // and the gate compares each scenario against its OWN baseline, so absolute peak RSS is already
  // comparable run-to-run — which is the only comparison the gate makes. Cross-scenario
  // comparability was the sole thing normalization bought, and nothing consumed it.
  const peakRssMb = peakRss / (1024 * 1024);

  return [
    {
      key: "runtime.eventloop_p99_ms",
      value: eventloopP99Ms,
      unit: "ms",
      class: "warn",
      direction: "higher-worse",
    },
    {
      key: "runtime.peak_rss_mb",
      value: peakRssMb,
      unit: "mb",
      class: "warn",
      direction: "higher-worse",
    },
  ];
}
