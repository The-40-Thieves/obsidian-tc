// THE-1041 / GH #934: describe_capability's input_schema (and tools/list's inputSchema) were
// converted with zod's default io:"output" mode, which describes the PARSED result rather than
// what safeParse accepts — every .default()/.prefault() field read as required, and every plain
// (non-strict) object read as additionalProperties:false even though the server strips unknown
// keys there and accepts the call. output_schema stays output-mode; that direction is correct.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import { describeCapability, JSON_SCHEMA_OPTS } from "../src/mcp/facade";
import type { CallerContext, ToolDefinition } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";

function findOrThrow(defs: ToolDefinition[], name: string): ToolDefinition {
  const def = defs.find((d) => d.name === name);
  if (!def) throw new Error(`fixture registry has no tool named ${name}`);
  return def;
}

describe('THE-1041: input schemas emit in zod io:"input" mode', () => {
  it("describe_capability's input_schema matches the input-mode conversion for every registered tool", () => {
    const defs = buildFullRegistry().list();
    // RED-first floor: a vacuous pass over zero tools would report perfect coverage.
    expect(defs.length).toBeGreaterThan(100);

    const diverging: string[] = [];
    for (const def of defs) {
      const advertised = describeCapability(def).input_schema;
      const inputMode = z.toJSONSchema(def.inputSchema, { ...JSON_SCHEMA_OPTS, io: "input" });
      if (JSON.stringify(advertised) !== JSON.stringify(inputMode)) diverging.push(def.name);
    }
    // The reporter's repro (GH #934) found 98 of 163 diverging against zod's default io:"output".
    // Quoted in the RED report; must be exactly [] post-fix.
    const message = `tools whose advertised input_schema diverges from io:"input":\n  ${diverging.join("\n  ")}`;
    expect(diverging, message).toEqual([]);
  });

  it("describe_capability's output_schema still matches the OUTPUT-mode conversion", () => {
    const defs = buildFullRegistry()
      .list()
      .filter((d) => d.outputSchema);
    expect(defs.length).toBeGreaterThan(0);

    for (const def of defs) {
      const advertised = describeCapability(def).output_schema;
      const outputMode = z.toJSONSchema(def.outputSchema as z.ZodType, JSON_SCHEMA_OPTS);
      expect(advertised).toEqual(outputMode);
    }
  });

  it("write_note's advertised input_schema does not require options, and a call omitting it validates", () => {
    const def = findOrThrow(buildFullRegistry().list(), "write_note");
    const schema = describeCapability(def).input_schema as {
      required?: string[];
      properties?: Record<string, { additionalProperties?: boolean; required?: string[] }>;
    };
    expect(schema.required ?? []).not.toContain("options");

    const base = { vault: "t", path: "a.md", content: "x" };
    expect(def.inputSchema.safeParse(base).success).toBe(true);
  });

  it("a plain (non-strict) object inside a tool input emits WITHOUT additionalProperties:false, while .strict() ones keep it", () => {
    const def = findOrThrow(buildFullRegistry().list(), "write_note");
    const schema = describeCapability(def).input_schema as {
      properties?: Record<string, { additionalProperties?: boolean }>;
      additionalProperties?: boolean;
    };
    // options: WriteOptions.prefault({}) — WriteOptions is a plain z.object, not .strict().
    expect(schema.properties?.options?.additionalProperties).toBeUndefined();
    // The tool's own top-level schema is `.strict()` — that keeps additionalProperties:false.
    expect(schema.additionalProperties).toBe(false);
  });

  it("tools/list over a real in-memory MCP session returns input-mode inputSchema (flat mode)", async () => {
    const registry = buildFullRegistry();
    const context = (): CallerContext => ({
      caller: "stdio",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "t",
      db: {} as never,
    });
    const server = createMcpServer({
      name: "x",
      version: "0",
      registry,
      context,
      visibility: { grantedScopes: new Set(["*"]) },
      facadeMode: "flat",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(ct);

    const { tools } = await client.listTools();
    const writeNote = tools.find((t) => t.name === "write_note");
    expect(writeNote).toBeDefined();
    const inputSchema = writeNote?.inputSchema as { required?: string[] } | undefined;
    expect(inputSchema?.required ?? []).not.toContain("options");

    await client.close();
    await server.close();
  });
});
