import { describe, expect, it } from "vitest";
import { collectRuntime } from "../eval/perf/collectors/runtime";
import { buildVault } from "../eval/perf/harness";
import { SCENARIOS } from "../eval/perf/scenarios";

describe("runtime collectors", () => {
  it("emits non-negative event-loop delay and peak rss, both warn-class", async () => {
    const v = await buildVault(SCENARIOS.small);
    const samples = await collectRuntime(v);
    const byKey = Object.fromEntries(samples.map((s) => [s.key, s]));
    const eventloopSample = byKey["runtime.eventloop_p99_ms"];
    const rssSample = byKey["runtime.peak_rss_per_10k_mb"];
    expect(eventloopSample).toBeDefined();
    expect(rssSample).toBeDefined();
    if (eventloopSample && rssSample) {
      expect(eventloopSample.value).toBeGreaterThanOrEqual(0);
      expect(rssSample.value).toBeGreaterThan(0);
      expect(eventloopSample.class).toBe("warn");
      expect(rssSample.class).toBe("warn");
    }
    v.cleanup();
  });
});
