import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";

function testTool(name: string): ToolDefinition<Record<string, never>, Record<string, never>> {
  return {
    name,
    description: `test tool ${name}`,
    inputSchema: z.object({}).strict(),
    requiredScopes: [],
    handler: () => ({}),
  };
}

async function connect(registry: ToolRegistry, toolsPageSize?: number) {
  const context = (): CallerContext => ({
    caller: "stdio",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "v1",
    db: {} as never,
  });
  const server = createMcpServer({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry,
    context,
    toolsPageSize,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

function registryOf(...names: string[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const n of names) r.register(testTool(n));
  return r;
}

function toolWith(
  name: string,
  opts: { requiredScopes?: string[]; destructive?: boolean },
): ToolDefinition<Record<string, never>, Record<string, never>> {
  return {
    ...testTool(name),
    requiredScopes: opts.requiredScopes ?? [],
    destructive: opts.destructive,
  };
}

describe("tools/list pagination", () => {
  it("returns the whole surface in one page (no cursor) at the default page size", async () => {
    const { client, server } = await connect(registryOf("test_a", "test_b", "test_c"));
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(["test_a", "test_b", "test_c"]);
    // Non-paginating-client guarantee: the default page size dwarfs the tool surface.
    expect(listed.nextCursor).toBeUndefined();
    await client.close();
    await server.close();
  });

  it("pages via an opaque cursor when the surface exceeds the page size", async () => {
    const { client, server } = await connect(registryOf("test_a", "test_b", "test_c"), 2);
    const page1 = await client.listTools();
    expect(page1.tools).toHaveLength(2);
    expect(page1.nextCursor).toBe("2");
    const page2 = await client.listTools({ cursor: page1.nextCursor });
    expect(page2.tools).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();
    const all = [...page1.tools, ...page2.tools].map((t) => t.name).sort();
    expect(all).toEqual(["test_a", "test_b", "test_c"]);
    await client.close();
    await server.close();
  });

  it("treats a malformed cursor as the first page (graceful, per MCP spec)", async () => {
    const { client, server } = await connect(registryOf("test_a", "test_b", "test_c"), 2);
    const listed = await client.listTools({ cursor: "not-a-number" });
    expect(listed.tools).toHaveLength(2);
    expect(listed.nextCursor).toBe("2");
    await client.close();
    await server.close();
  });
});

describe("tools/list annotations + title", () => {
  it("derives read-only annotations for a non-mutating, non-destructive tool", async () => {
    const r = new ToolRegistry();
    r.register(toolWith("read_thing", { requiredScopes: ["read:notes"] }));
    const { client, server } = await connect(r);
    const tool = (await client.listTools()).tools[0]!;
    expect(tool.title).toBe("Read Thing");
    expect(tool.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    await client.close();
    await server.close();
  });

  it("marks a mutating tool as not read-only", async () => {
    const r = new ToolRegistry();
    r.register(toolWith("write_thing", { requiredScopes: ["write:notes"] }));
    const { client, server } = await connect(r);
    const tool = (await client.listTools()).tools[0]!;
    expect(tool.annotations?.readOnlyHint).toBe(false);
    expect(tool.annotations?.destructiveHint).toBe(false);
    await client.close();
    await server.close();
  });

  it("marks a destructive tool with destructiveHint and not read-only", async () => {
    const r = new ToolRegistry();
    r.register(toolWith("delete_thing", { requiredScopes: ["delete:notes"], destructive: true }));
    const { client, server } = await connect(r);
    const tool = (await client.listTools()).tools[0]!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    await client.close();
    await server.close();
  });
});
