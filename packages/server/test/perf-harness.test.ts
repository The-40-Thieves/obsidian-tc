import { describe, expect, it } from "vitest";
import { buildVault, quantiles } from "../eval/perf/harness";
import { SCENARIOS } from "../eval/perf/scenarios";

describe("perf harness synthetic vault", () => {
  it("is deterministic: same scenario -> identical chunk count + dup structure", async () => {
    const a = await buildVault(SCENARIOS.small);
    const b = await buildVault(SCENARIOS.small);
    expect(a.chunkCount).toBe(b.chunkCount);
    expect(a.provider.texts).toBe(b.provider.texts); // unique bodies embedded — identical
    expect(a.stats.chunks_upserted).toBe(b.stats.chunks_upserted);
    a.cleanup();
    b.cleanup();
  });

  it("embeds fewer texts than chunks because of the duplicate-body set", async () => {
    const v = await buildVault(SCENARIOS.small);
    expect(v.provider.texts).toBeLessThan(v.chunkCount);
    expect(v.provider.texts).toBeGreaterThan(0);
    v.cleanup();
  });

  it("quantiles() returns p50<=p95<=p99", () => {
    const q = quantiles([5, 1, 4, 2, 3, 9, 7, 8, 6, 10]);
    expect(q.p50).toBeLessThanOrEqual(q.p95);
    expect(q.p95).toBeLessThanOrEqual(q.p99);
  });
});
