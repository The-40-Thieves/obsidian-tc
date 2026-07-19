import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { domainOfTool } from "../src/mcp/facade";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name.replace(/_/g, " ")} — does the thing.`,
    inputSchema: z.object({ x: z.string() }).strict(),
    requiredScopes: [],
    handler: (i: { x: string }) => ({ echo: i.x }),
  } as unknown as ToolDefinition;
}

async function connect(registry: ToolRegistry) {
  const context = (): CallerContext => ({
    caller: "stdio",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "v1",
    db: {} as never,
  });
  const server = createMcpServer({
    name: "x",
    version: "0",
    registry,
    context,
    facadeMode: "domain",
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  return { client, server };
}

function textOf(res: unknown): unknown {
  const content = (res as { content: [{ text: string }] }).content;
  return JSON.parse(content[0].text);
}

function realReg(): ToolRegistry {
  const r = new ToolRegistry();
  for (const n of [
    "read_note",
    "write_note",
    "delete_note",
    "search_text",
    "index_vault",
    "get_backlinks",
  ])
    r.register(tool(n));
  return r;
}

describe("domain-verb facade (THE-275)", () => {
  it("advertises one meta-tool per non-empty domain with an action enum", async () => {
    const { client, server } = await connect(realReg());
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["links", "notes", "search", "vault"]);
    const notes = tools.find((t) => t.name === "notes");
    const actions = (
      (notes?.inputSchema as { properties?: { action?: { enum?: string[] } } } | undefined)
        ?.properties?.action?.enum ?? []
    ).sort();
    expect(actions).toEqual(["delete_note", "read_note", "write_note"]);
    await client.close();
    await server.close();
  });

  it("routes a domain action through dispatch (same as a direct call)", async () => {
    const { client, server } = await connect(realReg());
    const res = await client.callTool({
      name: "notes",
      arguments: { action: "read_note", args: { x: "hi" } },
    });
    expect(textOf(res)).toEqual({ echo: "hi" });
    await client.close();
    await server.close();
  });

  it("a directly-named tool still dispatches in domain mode", async () => {
    const { client, server } = await connect(realReg());
    const res = await client.callTool({ name: "search_text", arguments: { x: "q" } });
    expect(textOf(res)).toEqual({ echo: "q" });
    await client.close();
    await server.close();
  });

  it("every representative capability maps to a real domain (no drift into 'other')", () => {
    for (const n of [
      "read_note",
      "update_frontmatter",
      "get_backlinks",
      "search_semantic",
      "index_vault",
      "ocr_attachment",
      "query_canvas",
      "save_workspace",
      "trigger_quickadd",
      "plur_recall",
      "knowledge_search",
      "inspect_acl",
    ])
      expect(domainOfTool(n)).toBeDefined();
  });
});
