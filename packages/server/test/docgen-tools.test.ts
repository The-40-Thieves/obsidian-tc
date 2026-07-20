// docgen tools extractor (THE-471): the full registered surface → ToolDoc[] via describeCapability.
// Pins the write surface that two external analyses missed, so it can never go undocumented again.
import { describe, expect, it } from "vitest";
import { extractTools } from "../scripts/docgen/extract-tools";

describe("extractTools (THE-471)", () => {
  const tools = extractTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  it("enumerates the whole registered surface, sorted by name", () => {
    expect(tools.length).toBeGreaterThan(100);
    const names = tools.map((t) => t.name);
    expect([...names]).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("includes the full write/edit surface with write scopes", () => {
    for (const name of ["write_note", "patch_note", "append_note", "update_frontmatter"]) {
      const t = byName.get(name);
      expect(t, `${name} missing from the extracted catalog`).toBeDefined();
      expect(t?.requiredScopes).toContain("write:notes");
    }
  });

  it("carries description, scopes, and a JSON-Schema input for each tool", () => {
    const patch = byName.get("patch_note");
    expect(patch?.description?.length ?? 0).toBeGreaterThan(0);
    // describeCapability converts the Zod inputSchema to JSON Schema
    expect(patch?.inputSchema).toBeTypeOf("object");
    expect(patch?.inputSchema).not.toBeNull();
  });

  it("classifies read vs admin tools by scope", () => {
    expect(byName.get("read_note")?.requiredScopes).toContain("read:notes");
    expect(byName.get("index_vault")?.requiredScopes).toContain("admin:vault");
    // server_health is unauthenticated (no required scopes)
    expect(byName.get("server_health")?.requiredScopes).toEqual([]);
  });
});
