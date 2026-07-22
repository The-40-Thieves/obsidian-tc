// docgen coverage lint (THE-476): a documented surface can never ship undocumented. Runs in the
// normal suite; the drift gate (ci-docgen.yml) enforces REGENERATION separately — that gate proves
// the generated pages are current, this proves there was something worth generating.
//
// Covers tools, metrics and error codes. Metrics and errors are both at FULL coverage today
// (16/16 and 34/34), so these are regression guards rather than a cleanup: they fail the moment
// someone adds an undocumented one, which is when the cost of fixing it is lowest.
//
// Config-key coverage remains the outstanding piece — the Zod schema does not .describe() every
// key yet, so asserting it today would fail ~everywhere. That is a schema change, not a lint
// change, and is tracked separately on THE-476.
import { describe, expect, it } from "vitest";
import { extractErrors } from "../scripts/docgen/extract-errors";
import { extractMetrics } from "../scripts/docgen/extract-metrics";
import { extractTools } from "../scripts/docgen/extract-tools";

const MIN_DESCRIPTION = 20;

describe("docgen coverage lint (THE-476)", () => {
  const tools = extractTools();

  it("the full surface is present (didn't silently collapse)", () => {
    expect(tools.length).toBeGreaterThan(100);
  });

  it("every tool has a description of at least 20 characters", () => {
    const thin = tools
      .filter((t) => (t.description ?? "").trim().length < MIN_DESCRIPTION)
      .map((t) => `${t.name} (${(t.description ?? "").trim().length})`);
    expect(thin, `tools with a missing/too-short description: ${thin.join(", ")}`).toEqual([]);
  });

  it("every tool advertises an input schema", () => {
    const noSchema = tools.filter((t) => t.inputSchema == null).map((t) => t.name);
    expect(noSchema, `tools without an input schema: ${noSchema.join(", ")}`).toEqual([]);
  });

  it("every metric carries help text", async () => {
    const metrics = await extractMetrics();
    const thin = metrics.filter((m) => !m.help?.trim()).map((m) => m.name);

    expect(metrics.length).toBeGreaterThan(0); // an empty extract must not pass vacuously
    expect(thin, `metrics missing help: ${thin.join(", ")}`).toEqual([]);
  });

  it("every metric declares its label names", async () => {
    // A metric whose labels are undocumented is one an operator cannot query or alert on.
    const metrics = await extractMetrics();
    const bad = metrics.filter((m) => !Array.isArray(m.labels)).map((m) => m.name);

    expect(bad, `metrics with no label array: ${bad.join(", ")}`).toEqual([]);
  });

  it("every error code carries a description", () => {
    const errors = extractErrors();
    const thin = errors.filter((e) => !e.description?.trim()).map((e) => e.code);

    expect(errors.length).toBeGreaterThan(0);
    expect(thin, `error codes missing a description: ${thin.join(", ")}`).toEqual([]);
  });
});
