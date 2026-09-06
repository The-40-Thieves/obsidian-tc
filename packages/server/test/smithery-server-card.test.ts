// THE-966: the Smithery server card generator (scripts/gen-smithery-server-card.ts) must build its
// `tools`/`prompts`/`resources` from the server's REAL registered definitions — triadTools(),
// listPrompts(), catalogResourceEntry() — never a hand-copied second source of truth. This pins
// the shape the registry API requires (each tool's `inputSchema.type === "object"`, per
// `@smithery/api`'s `ServerCard.Tool.InputSchema`) against fixture serverPkg/mcpServerJson inputs,
// mirroring how test/docgen-extractors.test.ts exercises the docgen scripts.
import { describe, expect, it } from "vitest";
import { buildServerCard } from "../scripts/gen-smithery-server-card";

const FIXTURE_INPUTS = {
  serverPkg: { name: "obsidian-tc", version: "1.28.3" },
  mcpServerJson: {
    description: "Model-agnostic, agent-ready Obsidian MCP server.",
    title: "Obsidian Turbocharged",
  },
};

describe("buildServerCard (THE-966)", () => {
  const card = buildServerCard(FIXTURE_INPUTS);

  it("carries serverInfo from the fixture inputs, plus the fixed websiteUrl", () => {
    expect(card.serverInfo).toEqual({
      name: "obsidian-tc",
      version: "1.28.3",
      description: "Model-agnostic, agent-ready Obsidian MCP server.",
      title: "Obsidian Turbocharged",
      websiteUrl: "https://github.com/The-40-Thieves/obsidian-tc",
    });
  });

  it("advertises exactly the three triad facade tools", () => {
    expect(card.tools.map((t) => t.name).sort()).toEqual([
      "call_capability",
      "describe_capability",
      "find_capability",
    ]);
  });

  it("every tool carries a JSON-Schema object inputSchema (the registry API's own requirement)", () => {
    expect(card.tools.length).toBeGreaterThan(0);
    for (const tool of card.tools) {
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("find_capability's description points at the catalog resource (hasResources=true)", () => {
    const find = card.tools.find((t) => t.name === "find_capability");
    expect(find?.description).toMatch(/obsidian-tc:\/\/catalog/);
  });

  it("carries the non-empty built-in prompt catalog", () => {
    expect(card.prompts.length).toBeGreaterThan(0);
    expect(card.prompts.every((p) => typeof p.name === "string" && p.name.length > 0)).toBe(true);
  });

  it("carries exactly one resource: the tool catalog", () => {
    expect(card.resources).toHaveLength(1);
    expect(card.resources[0]?.uri).toBe("obsidian-tc://catalog");
  });

  it("is a pure function of its inputs — two calls with the same fixture agree", () => {
    const again = buildServerCard(FIXTURE_INPUTS);
    expect(again).toEqual(card);
  });
});
