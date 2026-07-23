import { describe, expect, it } from "vitest";
import { runScenario } from "../eval/perf/run";

describe("perf run orchestration", () => {
  // THE-503 widened the default 5s timeout: the event-loop-delay fix (collectors/runtime.ts) now
  // runs real concurrent load instead of one call at a time, and the new concurrent-HTTP collector
  // (collectHttpConcurrency) adds 2- and 8-caller rounds -- both correctness improvements, not
  // slowdowns to work around, but they push a full runScenario() past 5s under parallel-suite load.
  it("produces a report with all deterministic hard-class keys present", async () => {
    const report = await runScenario("small");
    const keys = new Set(report.samples.map((s) => s.key));
    for (const k of [
      "index.chunk_count",
      "embed.dup_ratio",
      "graph.candidates_fused",
      "storage.bytes",
      "shutdown.drained",
    ]) {
      expect(keys.has(k)).toBe(true);
    }
    // every sample carries class + direction
    for (const s of report.samples) {
      expect(["hard", "warn"]).toContain(s.class);
      expect(["higher-worse", "lower-worse", "exact"]).toContain(s.direction);
    }
  }, 20_000);
});
