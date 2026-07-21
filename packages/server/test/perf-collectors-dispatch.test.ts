import { describe, expect, it } from "vitest";
import { collectDispatch } from "../eval/perf/collectors/dispatch";
import { buildVault } from "../eval/perf/harness";
import { SCENARIOS } from "../eval/perf/scenarios";

describe("dispatch + freshness collectors", () => {
  it("emits non-negative dispatch overhead quantiles and a freshness flag", async () => {
    const v = await buildVault(SCENARIOS.small);
    try {
      const byKey = Object.fromEntries((await collectDispatch(v)).map((s) => [s.key, s]));
      const p50 = byKey["dispatch.overhead_p50_ms"];
      const p95 = byKey["dispatch.overhead_p95_ms"];
      const p99 = byKey["dispatch.overhead_p99_ms"];
      const visible = byKey["freshness.visible"];
      const freshMs = byKey["freshness.ms"];
      expect(p50).toBeDefined();
      expect(p95).toBeDefined();
      expect(p99).toBeDefined();
      expect(visible).toBeDefined();
      expect(freshMs).toBeDefined();

      expect(p50!.value).toBeGreaterThanOrEqual(0);
      expect(p95!.value).toBeGreaterThanOrEqual(0);
      expect(p99!.value).toBeGreaterThanOrEqual(0);
      expect(visible!.value).toBe(1);
      expect(freshMs!.value).toBeGreaterThanOrEqual(0);

      expect(p95!.class).toBe("warn");
      expect(p95!.direction).toBe("higher-worse");
      expect(visible!.class).toBe("hard");
      expect(visible!.direction).toBe("exact");
      expect(freshMs!.class).toBe("warn");
    } finally {
      v.cleanup();
    }
  });
});
