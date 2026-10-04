// SDK 2.3 `maxToolInputElements` exists only on `McpServer`; this server is the low-level `Server`,
// so the equivalent guard lives in `tools/call` (mcp/tool-input-cap.ts). These pin: the counting
// rule, that the largest legitimate batch shapes sit far under the cap, and that an over-cap call
// is an `isError` result (not a transport failure) after which the SAME connection keeps serving.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { provisionCacheDb } from "../src/db/provision";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import {
  MAX_TOOL_INPUT_ELEMENTS,
  oversizedToolInput,
  toolInputElementCount,
} from "../src/mcp/tool-input-cap";
import { openMemoryDb } from "./helpers";

describe("toolInputElementCount", () => {
  it("counts array elements and object members, nested included", () => {
    // keys a,b (2) + a's two elements (2) + b's key c (1) + c's one element (1)
    expect(toolInputElementCount({ a: [1, 2], b: { c: [3] } }, 100)).toBe(6);
    expect(toolInputElementCount({}, 100)).toBe(0);
    expect(toolInputElementCount("text", 100)).toBe(0);
  });

  it("stops counting once the cap is passed, and survives very deep nesting", () => {
    expect(toolInputElementCount(new Array(1000).fill(0), 10)).toBe(11);
    let deep: unknown = [];
    for (let i = 0; i < 50_000; i++) deep = [deep];
    expect(toolInputElementCount(deep, MAX_TOOL_INPUT_ELEMENTS)).toBe(50_000);
  });

  it("leaves the largest legitimate shapes far under the cap", () => {
    // read_notes / read_resources accept 100 entries, bulk_set_property 500 paths (measured worst
    // case over every registered tool schema: 509).
    expect(oversizedToolInput("read_notes", { paths: new Array(100).fill("a.md") })).toBeNull();
    expect(
      oversizedToolInput("bulk_set_property", { paths: new Array(500).fill("a.md"), k: "v" }),
    ).toBeNull();
    expect(MAX_TOOL_INPUT_ELEMENTS / 509).toBeGreaterThan(900);
  });
});

describe("oversized tool-call arguments", () => {
  it("get an isError result, and the connection keeps serving", async () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const registry = new ToolRegistry();
    registry.register({
      name: "count_items",
      description: "test-only",
      inputSchema: z.object({ items: z.array(z.number()) }),
      requiredScopes: [],
      handler: (a: { items: number[] }) => ({ n: a.items.length }),
    } as never);
    const server = createMcpServer({
      name: "obsidian-tc",
      version: "0.0.0-test",
      registry,
      context: (): CallerContext => ({
        caller: "stdio",
        authenticated: true,
        grantedScopes: new Set(["*"]),
        vaultId: "v1",
        db,
      }),
      visibility: { grantedScopes: new Set(["*"]) },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "cap-test", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const big = await client.callTool({
        name: "count_items",
        arguments: { items: new Array(MAX_TOOL_INPUT_ELEMENTS).fill(0) },
      });
      // `items` itself is one member, so MAX elements in it is one past the cap.
      expect(big.isError).toBe(true);
      expect(JSON.stringify(big.content)).toContain("maximum of 500000 elements");

      const small = await client.callTool({
        name: "count_items",
        arguments: { items: new Array(100).fill(0) },
      });
      expect(small.isError).toBeFalsy();
      expect(small.structuredContent).toEqual({ n: 100 });
    } finally {
      await client.close();
    }
  }, 60_000);
});
