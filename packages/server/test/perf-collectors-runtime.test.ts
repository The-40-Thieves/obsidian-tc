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
    // THE-459: renamed from runtime.peak_rss_per_10k_mb — the old key extrapolated whole-process
    // RSS to a per-10k-chunk figure it could not actually attribute, and carried unit:"count".
    const rssSample = byKey["runtime.peak_rss_mb"];
    expect(eventloopSample).toBeDefined();
    expect(rssSample).toBeDefined();
    if (eventloopSample && rssSample) {
      expect(eventloopSample.value).toBeGreaterThanOrEqual(0);
      expect(rssSample.value).toBeGreaterThan(0);
      expect(eventloopSample.class).toBe("warn");
      expect(rssSample.class).toBe("warn");
      // The unit must match what the value actually holds — a mislabelled unit is what a
      // threshold comparison silently gets wrong (THE-503 tightens gating on these).
      expect(rssSample.unit).toBe("mb");
      expect(eventloopSample.unit).toBe("ms");
    }
    v.cleanup();
  });
});
