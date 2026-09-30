import { describe, expect, it } from "vitest";
import { runScenario } from "../eval/perf/run";
import { perfTimeout } from "./perf-timeouts";

describe("perf run orchestration", () => {
  // THE-503 widened the default 5s timeout: the event-loop-delay fix (collectors/runtime.ts) now
  // runs real concurrent load instead of one call at a time, and the new concurrent-HTTP collector
  // (collectHttpConcurrency) adds 2- and 8-caller rounds -- both correctness improvements, not
  // slowdowns to work around, but they push a full runScenario() past 5s under parallel-suite load.
  //
  // The boot probe is skipped: it spawns a subprocess (the slowest phase on windows-latest, ~1.0s
  // of ~4.1s) and none of the keys asserted below come from it. Its real spawn stays covered by
  // perf-isolate-integration.test.ts, which runs the whole `small` scenario in fresh processes.
  //
  // The Windows budget is sized against runner stalls, not the work; see perf-timeouts.ts.
  it(
    "produces a report with all deterministic hard-class keys present",
    async () => {
      const report = await runScenario("small", { skipBoot: true });
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
    },
    perfTimeout(20_000),
  );
});
