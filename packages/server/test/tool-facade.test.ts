import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolVisibilityConfig } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";

function tool(name: string, description: string, scopes: string[] = []): ToolDefinition {
  return {
    name,
    description,
    inputSchema: z.object({ x: z.string() }).strict(),
    requiredScopes: scopes,
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
  const server = createMcpServer({
    name: "x",
    version: "0",
    registry,
    context,
    visibility: { grantedScopes: new Set(["*"]) },
    facadeMode,
  });
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
  r.register(tool("read_note", "Read a note from the vault by path."));
  r.register(tool("reload_vault", "Reload and reindex the vault cache."));
  return r;
}

// THE-1098 (GH #964): a registry carrying a MUTATING record_retrieval_feedback (mirrors the real
// m8 tool's write:workspace scope) plus a non-mutating tool, so `requireReadOnly` hides exactly
// one of the two — the same shape the reporter's minimal reproducer relies on.
function regWithVisibility(toolVisibility: ToolVisibilityConfig): ToolRegistry {
  const r = new ToolRegistry({ toolVisibility });
  r.register(
    tool("record_retrieval_feedback", "Judge whether a prior retrieval helped.", [
      "write:workspace",
    ]),
  );
  r.register(tool("read_note", "Read a note from the vault by path."));
  return r;
}

function textOf(res: unknown): unknown {
  const content = (res as { content: [{ text: string }] }).content;
  return JSON.parse(content[0].text);
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
  it("ranks a name-matching tool first (THE-219 find ranking)", async () => {
    const { client, server } = await connect(reg(), "triad");
    const res = await client.callTool({
      name: "find_capability",
      arguments: { query: "read a note from the vault" },
    });
    const data = textOf(res) as { matches: { name: string }[] };
    expect(data.matches[0]?.name).toBe("read_note");
    await client.close();
    await server.close();
  });
});

// THE-1098 (GH #964): describe_capability answered a policy-hidden capability identically to one
// that was never registered ({"code": "not_found", "message": "unknown capability: ..."}), so an
// agent following the server's own instructions to call record_retrieval_feedback under
// `toolVisibility.requireReadOnly: true` could not tell "you can't use this here" from "this does
// not exist". These assert the distinct `capability_hidden` code fires ONLY for a disclosure-safe
// reason (mcp/visibility.ts's DISCLOSABLE_HIDDEN_REASONS) and every other hidden/unregistered case
// keeps the original `not_found` — an `allowed`-list hide is deliberately invisible, not disclosed.
describe("THE-1098 (GH #964): describe_capability distinguishes hidden from unregistered", () => {
  const REQUIRE_READ_ONLY: ToolVisibilityConfig = {
    hidden: [],
    disabled: [],
    hiddenTags: [],
    disabledTags: [],
    requireReadOnly: true,
  };

  it("a tool hidden by requireReadOnly answers capability_hidden with its reason, not not_found", async () => {
    const { client, server } = await connect(regWithVisibility(REQUIRE_READ_ONLY), "triad");
    const res = await client.callTool({
      name: "describe_capability",
      arguments: { name: "record_retrieval_feedback" },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatchObject({
      code: "capability_hidden",
      reason: "hidden_require_read_only",
    });
    await client.close();
    await server.close();
  });

  it("a name that was never registered still answers not_found (no reason to disclose)", async () => {
    const { client, server } = await connect(regWithVisibility(REQUIRE_READ_ONLY), "triad");
    const res = await client.callTool({
      name: "describe_capability",
      arguments: { name: "no_such_capability" },
    });
    expect(res.isError).toBe(true);
    const body = textOf(res);
    expect(body).toMatchObject({ code: "not_found" });
    expect(body).not.toHaveProperty("reason");
    await client.close();
    await server.close();
  });

  it("a name hidden by an `allowed` allowlist stays not_found — deliberately invisible", async () => {
    const { client, server } = await connect(
      regWithVisibility({ ...REQUIRE_READ_ONLY, requireReadOnly: false, allowed: ["read_note"] }),
      "triad",
    );
    const res = await client.callTool({
      name: "describe_capability",
      arguments: { name: "record_retrieval_feedback" },
    });
    expect(res.isError).toBe(true);
    const body = textOf(res);
    expect(body).toMatchObject({ code: "not_found" });
    expect(body).not.toHaveProperty("reason");
    await client.close();
    await server.close();
  });
});
