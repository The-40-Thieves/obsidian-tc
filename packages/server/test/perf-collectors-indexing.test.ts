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
    expect(dupRatio!.value).toBeGreaterThan(0);
    expect(dupRatio!.value).toBeLessThan(1);
    expect(chunkCount!.value).toBe(v.chunkCount);
    expect(dupRatio!.class).toBe("hard");
    expect(textsPerS!.class).toBe("warn");
    v.cleanup();
  });
});
