// What tools/list advertises for `outputSchema`, per `toolFacade.outputSchema` ("full" | "omit").
//
// Client reports behind it (obsidian-tc keeps "full" as the default; "omit" is the opt-out):
//   - Cursor blanks the WHOLE server when an advertised outputSchema root is not `type: object`;
//   - Claude Desktop rejects a draft-07 outputSchema; claude.ai reportedly fails tools that
//     declare one at all;
//   - no client may ever see `annotations: null`.
// "omit" must change ONLY the advertisement: results keep structuredContent and the text block.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

type Listed = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

import { ToolFacadeConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import { mcpServerFacadeOptions } from "../src/mcp/facade-auto";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { UNADVERTISED_OUTPUTS } from "./schema-portability-rules";

const context = (): CallerContext => ({
  caller: "stdio",
  authenticated: true,
  grantedScopes: new Set(["*"]),
  vaultId: "v1",
  db: {} as never,
});

async function connect(
  registry: ToolRegistry,
  opts: { facadeMode: "flat" | "domain" | "triad"; outputSchema?: "full" | "omit" },
) {
  const server = createMcpServer({
    name: "x",
    version: "0",
    registry,
    context,
    visibility: { grantedScopes: new Set(["*"]) },
    ...opts,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  return { client, server };
}

const noNullAnnotations = (tools: Listed[]) =>
  tools.filter((t) => "annotations" in t && (t as { annotations: unknown }).annotations == null);

describe("config", () => {
  it("toolFacade.outputSchema defaults to 'full' and accepts only full | omit", () => {
    expect(ToolFacadeConfigSchema.parse({}).outputSchema).toBe("full");
    expect(ToolFacadeConfigSchema.parse({ outputSchema: "omit" }).outputSchema).toBe("omit");
    expect(ToolFacadeConfigSchema.safeParse({ outputSchema: "simplified" }).success).toBe(false);
  });

  it("is threaded from config into createMcpServer's options", () => {
    expect(mcpServerFacadeOptions({ mode: "flat", outputSchema: "omit" }).outputSchema).toBe(
      "omit",
    );
    expect(mcpServerFacadeOptions({ mode: "flat" }).outputSchema).toBeUndefined();
  });
});

describe("full registry, flat surface", () => {
  const registry = buildFullRegistry();

  it("default (full): every advertised outputSchema is a 2020-12 object root, no null annotations", async () => {
    const { client, server } = await connect(registry, { facadeMode: "flat" });
    const tools = (await client.listTools()).tools;
    expect(tools.length).toBeGreaterThan(100); // existence floor: the loop below is not vacuous
    const withSchema = tools.filter((t) => t.outputSchema !== undefined);
    // Only the pinned unconstrained-output tools go without one (schema lowering, THE-1393).
    const without = tools.filter((t) => t.outputSchema === undefined).map((t) => t.name);
    expect(without.sort()).toEqual([...UNADVERTISED_OUTPUTS].sort());
    for (const t of withSchema) {
      const s = t.outputSchema as { type?: unknown; $schema?: unknown };
      expect(s.type, t.name).toBe("object");
      expect(s.$schema, t.name).toBe("https://json-schema.org/draft/2020-12/schema");
    }
    expect(noNullAnnotations(tools).map((t) => t.name)).toEqual([]);
    await client.close();
    await server.close();
  });

  it("omit: tools/list carries no outputSchema on any tool, everything else is unchanged", async () => {
    const full = await connect(registry, { facadeMode: "flat", outputSchema: "full" });
    const omit = await connect(registry, { facadeMode: "flat", outputSchema: "omit" });
    const fullTools = (await full.client.listTools()).tools;
    const omitTools = (await omit.client.listTools()).tools;
    expect(omitTools.length).toBe(fullTools.length);
    expect(omitTools.filter((t) => "outputSchema" in t)).toEqual([]);
    const strip = ({ outputSchema: _drop, ...rest }: Listed) => rest;
    expect(omitTools).toEqual(fullTools.map(strip));
    expect(noNullAnnotations(omitTools)).toEqual([]);
    await full.client.close();
    await omit.client.close();
    await full.server.close();
    await omit.server.close();
  });

  it("omit also covers the domain surface", async () => {
    const { client, server } = await connect(registry, {
      facadeMode: "domain",
      outputSchema: "omit",
    });
    const tools = (await client.listTools()).tools;
    expect(tools.length).toBeGreaterThan(5);
    expect(tools.filter((t) => "outputSchema" in t)).toEqual([]);
    expect(noNullAnnotations(tools)).toEqual([]);
    await client.close();
    await server.close();
  });

  it("the default triad never carries null annotations either", async () => {
    const { client, server } = await connect(registry, { facadeMode: "triad" });
    const tools = (await client.listTools()).tools;
    // the three meta-tools plus the standard search/fetch pair
    expect(tools.map((t) => t.name).sort()).toEqual([
      "call_capability",
      "describe_capability",
      "fetch",
      "find_capability",
      "search",
    ]);
    expect(noNullAnnotations(tools)).toEqual([]);
    await client.close();
    await server.close();
  });
});

describe("omit leaves results alone", () => {
  const outputSchema = z.object({ title: z.string() }).strict();
  const def = {
    name: "titled",
    description: "titled desc",
    inputSchema: z.object({}).strict(),
    requiredScopes: [],
    outputSchema,
    handler: () => ({ title: "Hello" }),
  } as unknown as ToolDefinition;

  it("a call still returns structuredContent AND the text block", async () => {
    const r = new ToolRegistry();
    r.register(def);
    const { client, server } = await connect(r, { facadeMode: "flat", outputSchema: "omit" });
    expect((await client.listTools()).tools[0]?.outputSchema).toBeUndefined();
    const res = await client.callTool({ name: "titled", arguments: {} });
    expect(res.structuredContent).toEqual({ title: "Hello" });
    expect((res.content as { text: string }[])[0]?.text).toBe('{"title":"Hello"}');
    await client.close();
    await server.close();
  });
});
