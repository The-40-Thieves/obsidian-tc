import { describe, expect, it } from "vitest";
import { z } from "zod";
import { findCapability, toJson, triadTools } from "../src/mcp/facade";
import type { ToolDefinition } from "../src/mcp/registry";

describe("facade JSON-schema memoization (THE-294)", () => {
  it("returns the same converted object for the same schema instance", () => {
    const schema = z.object({ a: z.string() }).strict();
    const first = toJson(schema);
    const second = toJson(schema);
    // Identity, not just deep-equality: the conversion ran once and was cached.
    expect(second).toBe(first);
  });

  it("converts distinct schemas independently", () => {
    const a = toJson(z.object({ a: z.string() })) as { properties?: Record<string, unknown> };
    const b = toJson(z.object({ b: z.number() })) as { properties?: Record<string, unknown> };
    expect(a).not.toBe(b);
    expect(a.properties).toHaveProperty("a");
    expect(b.properties).toHaveProperty("b");
  });

  it("triad meta-tool schemas are stable across calls (hoisted + memoized)", () => {
    const a = triadTools();
    const b = triadTools();
    expect(a).toHaveLength(3);
    for (let i = 0; i < a.length; i++) {
      // Same memoized object across independent triadTools() calls.
      expect(b[i]?.inputSchema).toBe(a[i]?.inputSchema);
    }
  });
});

describe("findCapability memoization (THE-294)", () => {
  const tool = (name: string, description: string): ToolDefinition =>
    ({
      name,
      description,
      inputSchema: z.object({}),
      requiredScopes: [],
      handler: () => ({}),
    }) as unknown as ToolDefinition;
  const tools = [
    tool("read_note", "Read a note from the vault by path."),
    tool("search_text", "Full-text search across the vault."),
  ];

  it("ranks a name-matching tool first and is stable across repeated queries", () => {
    const first = findCapability(tools, "read note", 5);
    const second = findCapability(tools, "read note", 5);
    expect(first[0]?.name).toBe("read_note");
    // Memoized per-tool docs -> identical results on repeat.
    expect(second).toEqual(first);
  });
});

describe("THE-463 assembled-catalog memoization", () => {
  const def = (name: string): ToolDefinition =>
    ({
      name,
      description: `does ${name}`,
      inputSchema: z.object({ a: z.string() }),
      requiredScopes: [],
    }) as unknown as ToolDefinition;

  it("triadTools returns the SAME array instance across calls (built once)", async () => {
    const { triadTools } = await import("../src/mcp/facade");
    expect(triadTools()).toBe(triadTools());
  });

  it("describeCapability memoizes by def identity", async () => {
    const { describeCapability } = await import("../src/mcp/facade");
    const d = def("read_note");
    expect(describeCapability(d)).toBe(describeCapability(d));
    // distinct defs are independent
    expect(describeCapability(d)).not.toBe(describeCapability(def("write_note")));
  });

  it("toMcpTool reuses the same frozen Tool object per def (flat catalog not rebuilt)", async () => {
    const { toMcpTool } = await import("../src/mcp/server");
    const d = def("search_vault");
    const first = toMcpTool(d);
    const second = toMcpTool(d);
    expect(second).toBe(first); // same instance -> the flat projection is not rebuilt per request
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.name).toBe("search_vault");
  });
});
