// suggest_tags over a REAL MCP connection (in-memory transport, stdio-shaped: a legacy
// `initialize` that carries the client's capabilities). The unit tests stub `ctx.sample`; this is
// the leg that proves the wiring in mcp/server.ts hands the tool a `sample` that reaches a client's
// own `sampling/createMessage` handler — and that a client which never advertised sampling gets the
// heuristic rather than a protocol error.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server";
import { makeTestVault } from "./m1-helpers";

async function connect(v: ReturnType<typeof makeTestVault>, client: Client) {
  const server = createMcpServer({
    name: "x",
    version: "0",
    registry: v.registry,
    context: () => v.ctx(),
    visibility: { grantedScopes: new Set(["*"]) },
    facadeMode: "flat",
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return server;
}

const FILES = { "a.md": "Sourdough bread baking.", "b.md": "#baking\n#bread" };

describe("suggest_tags over a real MCP connection", () => {
  it("a sampling-capable client answers the server's sampling/createMessage", async () => {
    const v = makeTestVault({ files: FILES });
    const seen: unknown[] = [];
    const client = new Client({ name: "t", version: "0" }, { capabilities: { sampling: {} } });
    client.setRequestHandler(CreateMessageRequestSchema, async (req) => {
      seen.push(req.params);
      return {
        model: "e2e-model",
        role: "assistant" as const,
        content: { type: "text" as const, text: '{"tags":["bread","sourdough"]}' },
      };
    });
    const server = await connect(v, client);
    try {
      const res = await client.callTool({
        name: "suggest_tags",
        arguments: { vault: "test", path: "a.md" },
      });
      expect(res.isError).toBeFalsy();
      const out = res.structuredContent as {
        source: string;
        sampling: { status: string; model?: string };
        suggestions: Array<{ tag: string; in_vocabulary: boolean }>;
      };
      expect(out.source).toBe("client-sampled");
      expect(out.sampling).toEqual({ status: "sampled", model: "e2e-model" });
      expect(out.suggestions).toEqual([
        { tag: "bread", in_vocabulary: true },
        { tag: "sourdough", in_vocabulary: false },
      ]);
      expect(seen).toHaveLength(1);
      expect((seen[0] as { maxTokens: number }).maxTokens).toBe(256);
    } finally {
      await client.close();
      await server.close();
      v.cleanup();
    }
  });

  it("a client that never advertised sampling gets the labelled heuristic, not an error", async () => {
    const v = makeTestVault({ files: FILES });
    const client = new Client({ name: "t", version: "0" });
    const server = await connect(v, client);
    try {
      const res = await client.callTool({
        name: "suggest_tags",
        arguments: { vault: "test", path: "a.md" },
      });
      expect(res.isError).toBeFalsy();
      const out = res.structuredContent as {
        source: string;
        sampling: { status: string };
        suggestions: Array<{ tag: string }>;
      };
      expect(out.source).toBe("heuristic");
      expect(out.sampling.status).toBe("unsupported");
      expect(out.suggestions.map((s) => s.tag)).toEqual(["baking", "bread"]);
    } finally {
      await client.close();
      await server.close();
      v.cleanup();
    }
  });

  it("a client that advertises sampling but errors on the request gets the heuristic", async () => {
    const v = makeTestVault({ files: FILES });
    const client = new Client({ name: "t", version: "0" }, { capabilities: { sampling: {} } });
    client.setRequestHandler(CreateMessageRequestSchema, async () => {
      throw new Error("user declined");
    });
    const server = await connect(v, client);
    try {
      const res = await client.callTool({
        name: "suggest_tags",
        arguments: { vault: "test", path: "a.md" },
      });
      const out = res.structuredContent as { source: string; sampling: { status: string } };
      expect(out.source).toBe("heuristic");
      expect(out.sampling.status).toBe("declined_or_failed");
    } finally {
      await client.close();
      await server.close();
      v.cleanup();
    }
  });
});
