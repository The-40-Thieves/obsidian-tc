import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeCapability, domainTools, triadTools } from "../src/mcp/facade";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";

const D2020 = "https://json-schema.org/draft/2020-12/schema";

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name.replace(/_/g, " ")} — does the thing.`,
    inputSchema: z.object({ x: z.string() }).strict(),
    requiredScopes: [],
    handler: (i: { x: string }) => ({ echo: i.x }),
  } as unknown as ToolDefinition;
}

function schemaOf(t: { inputSchema?: unknown }): string | undefined {
  return (t.inputSchema as { $schema?: string } | undefined)?.$schema;
}

async function connect(registry: ToolRegistry, facadeMode: "triad" | "domain" | "flat") {
  const context = (): CallerContext => ({
    caller: "stdio",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "v1",
    db: {} as never,
  });
  const server = createMcpServer({ name: "x", version: "0", registry, context, facadeMode });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  return { client, server };
}

describe("THE-278 JSON Schema 2020-12 emission (MCP 2025-11-25 default dialect)", () => {
  it("triad meta-tools emit 2020-12", () => {
    for (const t of triadTools()) expect(schemaOf(t)).toBe(D2020);
  });

  it("domain meta-tools emit 2020-12", () => {
    const tools = domainTools([tool("read_note"), tool("search_text")]);
    for (const t of tools) expect(schemaOf(t)).toBe(D2020);
  });

  it("describe_capability input_schema is 2020-12", () => {
    const out = describeCapability(tool("read_note")) as { input_schema?: { $schema?: string } };
    expect(out.input_schema?.$schema).toBe(D2020);
  });

  it("flat-mode tools/list emits 2020-12 over the wire", async () => {
    const r = new ToolRegistry();
    r.register(tool("read_note"));
    const { client, server } = await connect(r, "flat");
    const t = (await client.listTools()).tools.find((x) => x.name === "read_note");
    expect(schemaOf(t as { inputSchema?: unknown })).toBe(D2020);
    await client.close();
    await server.close();
  });
});
