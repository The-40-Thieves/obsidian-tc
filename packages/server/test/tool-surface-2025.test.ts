import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { describeCapability } from "../src/mcp/facade";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";

const D2020 = "https://json-schema.org/draft/2020-12/schema";

function tool(
  name: string,
  extra: Partial<ToolDefinition> = {},
  handler?: (i: { x: string }) => unknown,
): ToolDefinition {
  return {
    name,
    description: `${name} desc`,
    inputSchema: z.object({ x: z.string() }).strict(),
    requiredScopes: [],
    handler: handler ?? ((i: { x: string }) => ({ echo: i.x })),
    ...extra,
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
    facadeMode: "flat",
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  return { client, server };
}

describe("THE-278 validation-as-tool-errors (SEP-1303)", () => {
  it("a bad-args call resolves to a Tool Execution Error with readable text + structuredContent", async () => {
    const r = new ToolRegistry();
    r.register(tool("read_thing"));
    const { client, server } = await connect(r);
    // Missing required `x`. The promise RESOLVES (does not reject) -> it is an in-band tool error,
    // not a JSON-RPC protocol error.
    const res = await client.callTool({ name: "read_thing", arguments: {} });
    expect(res.isError).toBe(true);
    const text = (res.content as { text: string }[])[0]?.text ?? "";
    expect(text.startsWith("Error [validation_error]:")).toBe(true);
    expect(() => JSON.parse(text)).toThrow(); // a human sentence, not a raw JSON blob
    expect((res.structuredContent as { code?: string }).code).toBe("validation_error");
    await client.close();
    await server.close();
  });
});

describe("THE-278 icons", () => {
  it("tools/list + describe_capability carry icons only when set", async () => {
    const icons = [{ src: "data:image/png;base64,AAAA", mimeType: "image/png", sizes: ["48x48"] }];
    const r = new ToolRegistry();
    r.register(tool("with_icon", { icons }));
    r.register(tool("no_icon"));
    const { client, server } = await connect(r);
    const list = (await client.listTools()).tools;
    expect(list.find((t) => t.name === "with_icon")?.icons).toEqual(icons);
    expect(list.find((t) => t.name === "no_icon")?.icons).toBeUndefined();
    await client.close();
    await server.close();
    expect((describeCapability(tool("with_icon", { icons })) as { icons?: unknown }).icons).toEqual(
      icons,
    );
    expect((describeCapability(tool("no_icon")) as { icons?: unknown }).icons).toBeUndefined();
  });
});

describe("THE-278 outputSchema + structuredContent", () => {
  it("advertises outputSchema (2020-12) and a conformant client validates structuredContent", async () => {
    const outputSchema = z.object({ ok: z.boolean() }).strict();
    const r = new ToolRegistry();
    r.register(tool("structured", { outputSchema }, () => ({ ok: true })));
    r.register(tool("plain"));
    const { client, server } = await connect(r);
    const list = (await client.listTools()).tools;
    const s = list.find((t) => t.name === "structured");
    expect((s?.outputSchema as { $schema?: string })?.$schema).toBe(D2020);
    expect((s?.outputSchema as { type?: string })?.type).toBe("object");
    expect(list.find((t) => t.name === "plain")?.outputSchema).toBeUndefined();
    // The SDK client REQUIRES + validates structuredContent against the advertised outputSchema.
    const res = await client.callTool({ name: "structured", arguments: { x: "hi" } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({ ok: true });
    await client.close();
    await server.close();
  });
});

describe("THE-457 strict output-schema enforcement", () => {
  const stubDb = {
    prepare: () => ({ get: () => undefined, run: () => ({ changes: 0 }), all: () => [] }),
    exec: () => {},
  } as unknown as CallerContext["db"];
  const ctx = (): CallerContext => ({
    caller: "t",
    authenticated: true,
    grantedScopes: new Set(["*"]),
    vaultId: "v1",
    db: stubDb,
  });
  const schema = z.object({ ok: z.boolean() }).strict();

  it("warn mode (default): a payload violating outputSchema still returns ok", async () => {
    const r = new ToolRegistry();
    r.register(tool("bad", { outputSchema: schema }, () => ({ ok: "not-a-boolean" })));
    const res = await r.dispatch("bad", { x: "hi" }, ctx());
    expect(res.ok).toBe(true); // warn-only: the malformed payload is still returned
  });

  it("strict mode: the same violation is a hard typed error, not a returned payload", async () => {
    const r = new ToolRegistry({ strictOutputSchema: true });
    r.register(tool("bad", { outputSchema: schema }, () => ({ ok: "not-a-boolean" })));
    const res = await r.dispatch("bad", { x: "hi" }, ctx());
    expect(res.ok).toBe(false); // contract violation fails instead of shipping bad structuredContent
  });

  it("strict mode: a conformant payload passes unaffected", async () => {
    const r = new ToolRegistry({ strictOutputSchema: true });
    r.register(tool("good", { outputSchema: schema }, () => ({ ok: true })));
    const res = await r.dispatch("good", { x: "hi" }, ctx());
    expect(res.ok).toBe(true);
  });
});

describe("THE-278 protocol version", () => {
  it("negotiates MCP 2025-11-25 (the SDK dependency's advertised latest)", async () => {
    // The package.json floor (>=1.29.0) guarantees the SDK advertises 2025-11-25 as its latest;
    // the server negotiates the SDK default, so a floor regression would drop this below target.
    expect(LATEST_PROTOCOL_VERSION).toBe("2025-11-25");
    // And a real client completes the initialize handshake against the server.
    const { client, server } = await connect(new ToolRegistry());
    expect(client.getServerVersion()?.name).toBeDefined();
    await client.close();
    await server.close();
  });
});
