// THE-515: structural guard against the measured regression — importing the published barrel
// (index.ts, which re-exports ToolRegistry) evaluating the entire OTEL SDK even though
// observability.otel.endpoint is unset by default (initOtel's first line is a no-op guard).
// SPAN_ATTR moved to otel/attrs.ts (a leaf module, no SDK imports) specifically so mcp/registry.ts
// could keep using the attribute keys without pulling in @opentelemetry/exporter-trace-otlp-http,
// resources, sdk-trace-node or semantic-conventions.
//
// This MUST run as a subprocess (otel-lazy-probe.ts), not an in-process check: by the time this
// test file itself has loaded, vitest's own module graph may already have the OTEL SDK warm from
// an unrelated test, which would make an in-process timing lie in the "safe" direction. Confirmed
// by deliberately reverting otel/tracing.ts + mcp/registry.ts to their pre-fix imports and
// re-running the probe: otel_sdk_after_index_ms dropped from ~90-270ms (cold) to ~0.06-0.08ms (a
// module-cache hit) — this test would have failed against the code this ticket is fixing.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CACHE_HIT_THRESHOLD_MS, type OtelLazyProbeResult } from "../eval/perf/otel-lazy-probe";

const PROBE = fileURLToPath(new URL("../eval/perf/otel-lazy-probe.ts", import.meta.url));

function runProbe(): OtelLazyProbeResult {
  const r = spawnSync("bun", [PROBE], { encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) {
    throw new Error(`otel lazy probe subprocess exited ${r.status}: ${r.stderr}`);
  }
  const line = r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .at(-1);
  if (!line) throw new Error("otel lazy probe produced no output");
  return JSON.parse(line) as OtelLazyProbeResult;
}

describe("THE-515: OTEL SDK stays out of the published barrel's import graph", () => {
  it("does not load the OTEL SDK by importing index.ts (default-off feature, no endpoint set)", () => {
    const result = runProbe();
    // A near-zero duration means the module was already in the cache, i.e. index.ts's transitive
    // import graph pulled it in eagerly — the regression this guard exists to catch.
    expect(result.otel_sdk_after_index_ms).toBeGreaterThan(CACHE_HIT_THRESHOLD_MS);
  });
});
