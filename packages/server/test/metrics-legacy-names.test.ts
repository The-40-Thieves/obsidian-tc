import { describe, expect, it } from "vitest";
import { withLegacyMetricNames } from "../src/metrics/legacy-names";

describe("withLegacyMetricNames: 2.x dual-emits every family under its pre-2.0 name", () => {
  const exposition = [
    "# HELP reliquary_tc_tool_calls_total Tool calls.",
    "# TYPE reliquary_tc_tool_calls_total counter",
    'reliquary_tc_tool_calls_total{tool="read_note",outcome="ok"} 3',
    "# HELP process_cpu_seconds_total Total user and system CPU time.",
    "# TYPE process_cpu_seconds_total counter",
    "process_cpu_seconds_total 1.5",
    "",
  ].join("\n");

  it("keeps the current output first and unchanged", () => {
    expect(withLegacyMetricNames(exposition).startsWith(exposition)).toBe(true);
  });

  it("appends each project family again under the old prefix, HELP and TYPE included", () => {
    const out = withLegacyMetricNames(exposition);
    expect(out).toContain("# HELP obsidian_tc_tool_calls_total Tool calls.");
    expect(out).toContain("# TYPE obsidian_tc_tool_calls_total counter");
    expect(out).toContain('obsidian_tc_tool_calls_total{tool="read_note",outcome="ok"} 3');
  });

  it("does not duplicate families that never carried the project prefix", () => {
    const out = withLegacyMetricNames(exposition);
    expect(out.match(/^process_cpu_seconds_total /gm)).toHaveLength(1);
  });

  it("does not rewrite label values that happen to contain the prefix", () => {
    const out = withLegacyMetricNames('reliquary_tc_x{path="reliquary_tc_y"} 1\n');
    expect(out).toContain('obsidian_tc_x{path="reliquary_tc_y"} 1');
  });

  it("ends with exactly one trailing newline", () => {
    expect(withLegacyMetricNames(exposition).endsWith("\n")).toBe(true);
    expect(withLegacyMetricNames(exposition).endsWith("\n\n")).toBe(false);
  });
});
