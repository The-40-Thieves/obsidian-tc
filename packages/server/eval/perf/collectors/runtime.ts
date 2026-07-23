import { monitorEventLoopDelay } from "node:perf_hooks";
import { deterministicVector } from "../../../src/embeddings/fake";
import { graphSearch } from "../../../src/search/graph_search";
import type { VaultCtx } from "../harness";
import type { MetricSample } from "../report";

// THE-503 known-measurement-artifact fix: `runtime.eventloop_p99_ms` used to read 0 almost every
// run. Root cause (confirmed empirically, not guessed): the old load loop issued ONE `await`ed
// graphSearch call at a time. Each call resolves through nothing but microtasks, and microtasks
// always drain completely before Node/Bun's event loop returns to its poll phase -- so control
// never actually crossed a macrotask boundary while the load ran, and monitorEventLoopDelay's
// internal check (which is driven off that boundary) recorded ZERO samples at all (`h.count`
// was 0), not a genuine "delay below resolution". A histogram with no samples reports 0 from
// `.percentile()`, silently indistinguishable from "no delay" -- exactly the "0 that is really
// below measurable" the ticket warns about.
//
// Fix, per the ticket's own two remedies, applied together:
//  1. "reduce the resolution" -> 1ms, the minimum monitorEventLoopDelay accepts (an integer >= 1).
//  2. "lengthen the workload" -> concurrent BATCHES of graphSearch calls (real load, not one call
//     at a time) with an explicit macrotask yield (`setImmediate`) between batches, so the loop
//     actually crosses the boundary the monitor samples at, repeated enough times to accumulate a
//     non-degenerate distribution rather than one or two data points.
const LOAD_CONCURRENCY = 4;
const LOAD_BATCHES = 20;

/** Family 6 (event-loop delay under load) + 10 (peak resident memory during the run). */
export async function collectRuntime(vault: VaultCtx): Promise<MetricSample[]> {
  const h = monitorEventLoopDelay({ resolution: 1 });
  h.enable();
  let peakRss = process.memoryUsage().rss;
  for (let b = 0; b < LOAD_BATCHES; b++) {
    const batch: Promise<unknown>[] = [];
    for (let c = 0; c < LOAD_CONCURRENCY; c++) {
      batch.push(
        graphSearch(vault.db, {
          query: "vault chunk graph",
          queryVec: deterministicVector("vault chunk graph", 32),
          vaultId: vault.vaultId,
          finalTopK: 10,
        }),
      );
    }
    await Promise.all(batch);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    // The macrotask boundary the fix above depends on -- see the comment block.
    await new Promise((resolve) => setImmediate(resolve));
  }
  h.disable();
  const eventloopP99Ms = h.count > 0 ? h.percentile(99) / 1e6 : 0; // ns -> ms; 0 only if genuinely no samples
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
