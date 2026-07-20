// docgen metrics/errors/schema extractors (THE-471). Runtime introspection: the prom-client registry,
// the err factory map, and a provisioned in-memory schema. Pins representative entries.
import { beforeAll, describe, expect, it } from "vitest";
import { extractErrors } from "../scripts/docgen/extract-errors";
import { extractMetrics } from "../scripts/docgen/extract-metrics";
import { extractSchema } from "../scripts/docgen/extract-schema";
import type { MetricDoc, TableDoc } from "../scripts/docgen/model";

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

describe("extractMetrics / extractSchema (THE-471)", () => {
  let metrics: MetricDoc[] = [];
  let tables: TableDoc[] = [];
  beforeAll(async () => {
    metrics = await extractMetrics();
    tables = await extractSchema();
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

  it("introspects the real provisioned schema (tables, columns, pk)", () => {
    expect(tables.length).toBeGreaterThan(10);
    const chunks = tables.find((t) => t.name === "chunks");
    expect(chunks).toBeDefined();
    const id = chunks?.columns.find((c) => c.name === "id");
    expect(id?.notes).toBe("pk");
    // every table has at least one column
    expect(tables.every((t) => t.columns.length > 0)).toBe(true);
  });
});
