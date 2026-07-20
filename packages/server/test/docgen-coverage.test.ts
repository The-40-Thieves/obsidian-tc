// docgen coverage lint (THE-476): every registered tool must carry a real description + an input
// schema, so a tool can never ship undocumented. Runs in the normal suite; the drift gate
// (ci-docgen.yml) enforces regeneration separately. (Config-key description coverage is a future
// tightening — the Zod schema does not .describe() every key yet.)
import { describe, expect, it } from "vitest";
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
});
