import { describe, expect, it } from "vitest";

import { collectIndexing } from "../eval/perf/collectors/indexing";
import { buildVault } from "../eval/perf/harness";
import { SCENARIOS } from "../eval/perf/scenarios";

describe("indexing collectors", () => {
  it("reports dup_ratio in (0,1) and exact counts", async () => {
    const v = await buildVault(SCENARIOS.small);
    const samples = collectIndexing(v, 50);
    const byKey = Object.fromEntries(samples.map((s) => [s.key, s]));
    const dupRatio = byKey["embed.dup_ratio"];
    const chunkCount = byKey["index.chunk_count"];
    const textsPerS = byKey["embed.texts_per_s"];
    expect(dupRatio).toBeDefined();
    expect(chunkCount).toBeDefined();
    expect(textsPerS).toBeDefined();
    expect(dupRatio?.value).toBeGreaterThan(0);
    expect(dupRatio?.value).toBeLessThan(1);
    expect(chunkCount?.value).toBe(v.chunkCount);
    expect(dupRatio?.class).toBe("hard");
    expect(textsPerS?.class).toBe("warn");
    v.cleanup();
  });

  // THE-503: transaction-count must be "fewer is better", not an exact-match invariant that
  // structurally can never recognize a legitimate batching improvement (THE-500).
  it("reports index.txn_count as a real, lower-is-better write-transaction count", async () => {
    const v = await buildVault(SCENARIOS.small);
    const samples = collectIndexing(v, 50);
    const txnCount = samples.find((s) => s.key === "index.txn_count");
    expect(txnCount).toBeDefined();
    expect(txnCount?.value).toBe(v.writeTxnCount);
    expect(txnCount?.value).toBeGreaterThan(0);
    // THE-500 batches many notes into ONE transaction per flush (default 100 notes / 8MiB); the
    // small scenario's 100 notes fit in a single flush, so this must be far below "one txn per
    // chunk" (200 chunks) -- proof the metric actually reflects batching, not a per-chunk count.
    expect(txnCount?.value).toBeLessThan(v.chunkCount);
    expect(txnCount?.class).toBe("hard");
    // "lower is better" for a cost metric is direction "higher-worse" in this codebase's
    // convention (report.ts: higher-worse => a higher value is the regression, i.e. lower wins) —
    // NOT "lower-worse", which means the opposite (a drop is the regression, e.g. throughput).
    expect(txnCount?.direction).toBe("higher-worse");
    v.cleanup();
  });
});
