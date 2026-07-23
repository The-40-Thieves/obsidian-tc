// Real end-to-end isolation test: unlike perf-sample.test.ts (which injects a fake spawn to keep
// the orchestration logic fast to test), this exercises the ACTUAL default `spawn` -- genuinely
// fresh `bun eval/perf/run.ts` subprocesses, one per sample, no shared state between them. This is
// what proves THE-503's isolation claim rather than just asserting it: if subprocess isolation
// were broken (e.g. accidentally reusing one build across samples), this test's hard-class CV
// assertion below would catch it, because a shared/corrupted vault would not reproduce identical
// deterministic counts run to run.
import { describe, expect, it } from "vitest";
import { checkHardStability } from "../eval/perf/isolate";
import { runIsolatedSamples } from "../eval/perf/sample";

describe("runIsolatedSamples() end-to-end (real bun subprocesses)", () => {
  it("spawns N genuinely fresh subprocesses and every hard-class metric agrees exactly across them", async () => {
    const result = runIsolatedSamples("small", { n: 2 });

    expect(result.aggregate.n).toBe(2);
    // The deterministic seeded corpus must reproduce byte-identical hard invariants across TWO
    // completely separate process launches -- this is the isolation layer's core promise.
    expect(checkHardStability(result.aggregate)).toEqual([]);
    expect(result.hardInstabilities).toEqual([]);

    const chunkCount = result.aggregate.samples.find((s) => s.key === "index.chunk_count");
    expect(chunkCount?.raw).toHaveLength(2);
    expect(chunkCount?.raw[0]).toBe(chunkCount?.raw[1]);
    expect(chunkCount?.cv).toBe(0);

    // Every subprocess reported its own calibration probe -- contention detection has real
    // (not injected) data to work with.
    expect(result.contention.raw).toHaveLength(2);
    expect(result.contention.raw.every((v) => v > 0)).toBe(true);
  }, 60_000);
});
