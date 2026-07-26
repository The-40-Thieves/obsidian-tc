// docgen metrics/errors extractors (THE-471). Runtime introspection: the prom-client registry and
// the err factory map. Pins representative entries.
import { beforeAll, describe, expect, it } from "vitest";
import { extractErrors } from "../scripts/docgen/extract-errors";
import { extractMetrics } from "../scripts/docgen/extract-metrics";
import type { MetricDoc } from "../scripts/docgen/model";

describe("extractErrors (THE-471)", () => {
  const errors = extractErrors();
  const byCode = new Map(errors.map((e) => [e.code, e]));

  it("extracts the taxonomy, deduped + sorted by code", () => {
    expect(errors.length).toBeGreaterThan(20);
    const codes = errors.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length); // no dup codes
    expect([...codes]).toEqual([...codes].sort((a, b) => a.localeCompare(b)));
  });

  it("carries the human fallback message as the description", () => {
    expect(byCode.get("not_found")?.description).toBeTruthy();
    expect(byCode.get("acl_denied")?.description).toMatch(/acl/i);
    expect(byCode.has("throttled")).toBe(true);
  });
});

describe("extractMetrics (THE-471)", () => {
  let metrics: MetricDoc[] = [];
  beforeAll(async () => {
    metrics = await extractMetrics();
  });

  it("extracts metrics with type, help, and sorted label names", () => {
    expect(metrics.length).toBeGreaterThan(5);
    const tc = metrics.find((m) => m.name === "obsidian_tc_tool_calls_total");
    expect(tc?.type).toBe("counter");
    expect(tc?.help?.length ?? 0).toBeGreaterThan(0);
    expect(tc?.labels).toEqual(["status", "tool", "vault"]); // sorted
    const names = metrics.map((m) => m.name);
    expect([...names]).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("carries every histogram's bucket bounds (THE-595), and nothing else's", () => {
    const histograms = metrics.filter((m) => m.type === "histogram");
    expect(histograms.length).toBeGreaterThan(0);
    for (const h of histograms) {
      expect(Array.isArray(h.buckets), `${h.name} is missing bucket bounds`).toBe(true);
      expect((h.buckets ?? []).length).toBeGreaterThan(0);
    }
    const responseBytes = metrics.find((m) => m.name === "obsidian_tc_response_bytes");
    // Pins the actual configured buckets (registry.ts's RESPONSE_BYTE_BUCKETS), so a bucket
    // change here is caught the same way a renamed metric already is above.
    expect(responseBytes?.buckets).toEqual([1_000, 10_000, 100_000, 1_000_000, 10_000_000]);

    const nonHistograms = metrics.filter((m) => m.type !== "histogram");
    expect(nonHistograms.every((m) => m.buckets === undefined)).toBe(true);
  });
});
