import { describe, expect, it } from "vitest";
import { runScenario } from "../eval/perf/run";

describe("perf run orchestration", () => {
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
  });
});
