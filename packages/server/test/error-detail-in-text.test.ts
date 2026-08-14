// THE-823: the error text block is a caller's ENTIRE diagnostic surface, not structuredContent.
//
// Real MCP clients discard `structuredContent` on an `isError: true` result and render the text
// line alone. Before this fix, errorToResult (mcp/server.ts) built that line from code + message +
// retryable only — the Zod issues naming the offending field lived exclusively in
// structuredContent, so a caller saw "Error [validation_error]: input validation failed" with
// nothing to act on.
//
// THE CRITICAL TRAP: every assertion below reads `content[0].text`, never `structuredContent`. A
// test that asserted on structuredContent would pass while reproducing the exact bug this closes.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { makeTestVault } from "./m1-helpers";

function tool(name: string, inputSchema: z.ZodTypeAny): ToolDefinition {
  return {
    name,
    description: `test tool ${name}`,
    inputSchema,
    requiredScopes: [],
    handler: (i: unknown) => ({ echo: i }),
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

/** The MCP client returns `content` typed loosely; every case here needs the raw text field. */
function textOf(res: unknown): string {
  const content = (res as { content: [{ text: string }] }).content;
  return content[0].text;
}

describe("THE-823: error detail reaches content[0].text", () => {
  it("a validation failure names the offending field in the text, not just the code", async () => {
    const registry = new ToolRegistry();
    registry.register(tool("greet", z.strictObject({ name: z.string() })));
    const { client, server } = await connect(registry, "flat");
    const res = await client.callTool({ name: "greet", arguments: { name: 5 } });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("name");
    // The old text: the caller's entire diagnostic surface used to be exactly this sentence.
    expect(text).not.toBe("Error [validation_error]: input validation failed");
    await client.close();
    await server.close();
  });

  it("call_capability with `arguments` instead of `args` names `arguments`, not the target's fields", async () => {
    const registry = new ToolRegistry();
    registry.register(tool("create_note", z.strictObject({ path: z.string() })));
    const { client, server } = await connect(registry, "triad");
    const res = await client.callTool({
      name: "call_capability",
      // THE-823's exact reproduction: the caller typo'd the envelope key.
      arguments: { name: "create_note", arguments: { path: "a.md" } },
    });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("arguments");
    // Before the fix: `args` silently defaulted to {}, create_note dispatched with no arguments,
    // and the caller was told ITS target's field ("path") was missing — the wrong diagnosis.
    expect(text).not.toContain("path");
    await client.close();
    await server.close();
  });

  it("caps a large issue list instead of rendering it unbounded", async () => {
    const registry = new ToolRegistry();
    const manyRequiredFields = z.strictObject(
      Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`field_${i}`, z.string()])),
    );
    registry.register(tool("wide", manyRequiredFields));
    const { client, server } = await connect(registry, "flat");
    // 10 missing-required issues.
    const res = await client.callTool({ name: "wide", arguments: {} });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    const renderedIssueLines = text.split("\n").filter((l) => l.startsWith("✖"));
    // The bound this fix chose: MAX_RENDERED_ISSUES = 5 in mcp/server.ts.
    expect(renderedIssueLines.length).toBe(5);
    expect(text).toMatch(/and 5 more/);
    await client.close();
    await server.close();
  });

  it("a malformed-frontmatter note surfaces the YAML parser's line/column AND the note path in the text", async () => {
    // THE-823 (deferred half, now closed): parseNote(raw) has ~19 non-test call sites; read_note's
    // is one of them, and it has `rel` in scope at the call, so the path is no longer dropped.
    const vault = makeTestVault({
      files: { "bad.md": "---\na: [1, 2\nb: bad\n---\nbody\n" },
    });
    const context = (): CallerContext => vault.ctx();
    const server = createMcpServer({
      name: "x",
      version: "0",
      registry: vault.registry,
      context,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
    const res = await client.callTool({
      name: "read_note",
      arguments: { vault: vault.id, path: "bad.md" },
    });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/line 2, column 1/);
    expect(text).toContain("bad.md");
    await client.close();
    await server.close();
    vault.cleanup();
  });
});
