import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";

function tool(name: string, description: string): ToolDefinition {
  return {
    name,
    description,
    inputSchema: z.object({ x: z.string() }).strict(),
    requiredScopes: [],
    handler: (i: { x: string }) => ({ echo: i.x }),
  } as unknown as ToolDefinition;
}

async function connect(registry: ToolRegistry, facadeMode?: "triad" | "domain" | "flat") {
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

function reg(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(tool("create_note", "Create a new note in the vault at the given path."));
  r.register(tool("search_vault", "Search the vault for notes matching a query."));
  return r;
}

function textOf(res: unknown): unknown {
  const content = (res as { content: { text: string }[] }).content;
  return JSON.parse(content[0]!.text);
}

describe("tool-surface facade (THE-219)", () => {
  it("triad mode advertises exactly the three meta-tools", async () => {
    const { client, server } = await connect(reg(), "triad");
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["call_capability", "describe_capability", "find_capability"]);
    await client.close();
    await server.close();
  });

  it("flat mode advertises the underlying tools", async () => {
    const { client, server } = await connect(reg(), "flat");
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("create_note");
    await client.close();
    await server.close();
  });

  it("find_capability surfaces the right tool for a query", async () => {
    const { client, server } = await connect(reg(), "triad");
    const res = await client.callTool({
      name: "find_capability",
      arguments: { query: "make a new note" },
    });
    const data = textOf(res) as { matches: { name: string }[] };
    expect(data.matches[0]?.name).toBe("create_note");
    await client.close();
    await server.close();
  });

  it("call_capability reaches a tool AND enforces the target's Layer-6 validation", async () => {
    const { client, server } = await connect(reg(), "triad");
    const ok = await client.callTool({
      name: "call_capability",
      arguments: { name: "create_note", args: { x: "hi" } },
    });
    expect(textOf(ok)).toMatchObject({ echo: "hi" });
    const bad = await client.callTool({
      name: "call_capability",
      arguments: { name: "create_note", args: { x: 123 } },
    });
    expect(bad.isError).toBe(true);
    await client.close();
    await server.close();
  });

  it("describe_capability returns the target's schema + hints", async () => {
    const { client, server } = await connect(reg(), "triad");
    const res = await client.callTool({
      name: "describe_capability",
      arguments: { name: "search_vault" },
    });
    const data = textOf(res) as { name: string; input_schema: unknown };
    expect(data.name).toBe("search_vault");
    expect(data.input_schema).toBeTruthy();
    await client.close();
    await server.close();
  });
});
