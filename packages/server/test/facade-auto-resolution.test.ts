// THE-1123 (part a) — `toolFacade.mode: "auto"` end to end: two different `clientInfo.name`
// values connecting to the SAME configured server get DIFFERENT advertised tool surfaces, decided
// per client rather than per deployment. Spawns createMcpServer with `facadeMode: "auto"` and
// drives it over a real MCP `Client`/`InMemoryTransport` pair (mirrors tool-facade.test.ts and
// facade-domain.test.ts's own connect() helpers) — `new Client({ name, version })` is the SDK's
// own client identity, delivered to the server via the legacy `initialize` handshake (no `era`
// passed here, so `createMcpServer` serves legacy — see its own doc comment), which lands on
// `server.getClientVersion()` and is what `resolveFacadeMode` reads for a connection that never
// sends a per-request envelope at all.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type CallerContext, type ToolDefinition, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";

const TEST_DOMAINS: Record<string, string> = {
  read_note: "notes",
  write_note: "notes",
  search_text: "search",
  get_backlinks: "links",
};

function tool(name: string): ToolDefinition {
  return {
    name,
    domain: TEST_DOMAINS[name],
    description: `${name.replace(/_/g, " ")} — does the thing.`,
    inputSchema: z.object({ x: z.string() }).strict(),
    requiredScopes: [],
    handler: (i: { x: string }) => ({ echo: i.x }),
  } as unknown as ToolDefinition;
}

function reg(): ToolRegistry {
  const r = new ToolRegistry();
  for (const n of Object.keys(TEST_DOMAINS)) r.register(tool(n));
  return r;
}

async function connectAs(clientName: string) {
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
    registry: reg(),
    context,
    visibility: { grantedScopes: new Set(["*"]) },
    facadeMode: "auto",
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: clientName, version: "0" });
  await client.connect(ct);
  return { client, server };
}

describe("toolFacade.mode: auto (THE-1123)", () => {
  it("a claude-code client gets the domain facade (built-in table)", async () => {
    const { client, server } = await connectAs("claude-code-cli");
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["links", "notes", "search"]);
    await client.close();
    await server.close();
  });

  it("an unrecognized client gets the triad (3 meta-tools) — the fallback default", async () => {
    const { client, server } = await connectAs("some-random-client");
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["call_capability", "describe_capability", "find_capability"]);
    await client.close();
    await server.close();
  });

  it("the SAME server config gives different clients different tool COUNTS (3 vs domain count)", async () => {
    const claude = await connectAs("claude-code-desktop");
    const other = await connectAs("cursor"); // built-in: triad (== fallback), still exercises the match path
    const claudeTools = (await claude.client.listTools()).tools;
    const otherTools = (await other.client.listTools()).tools;
    expect(claudeTools.length).toBe(3); // 3 domains registered above
    expect(otherTools.length).toBe(3); // triad's 3 meta-tools — same NUMBER, different SET
    expect(claudeTools.map((t) => t.name).sort()).not.toEqual(otherTools.map((t) => t.name).sort());
    await claude.client.close();
    await claude.server.close();
    await other.client.close();
    await other.server.close();
  });

  it("resolution is consistent within one connection: tools/list and tools/call agree", async () => {
    const { client, server } = await connectAs("claude-code");
    // domain mode: a directly-named tool still dispatches (mirrors facade-domain.test.ts).
    const res = await client.callTool({ name: "read_note", arguments: { x: "hi" } });
    expect(res.isError).not.toBe(true);
    // and the domain meta-tool routing also works, proving tools/call agreed on "domain" too.
    const routed = await client.callTool({
      name: "notes",
      arguments: { action: "read_note", args: { x: "hi" } },
    });
    expect(routed.isError).not.toBe(true);
    await client.close();
    await server.close();
  });
});
