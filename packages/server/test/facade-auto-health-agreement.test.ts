// THE-1123 review fix (HIGH) — reproduces the reviewer's exact finding: on a LEGACY stdio
// connection whose identity is only ever declared at `initialize` (never resent per-request, which
// is the normal legacy shape), `tools/list` and `server_health` used to DISAGREE about the
// resolved auto facade mode. `tools/list` read the resolver's cache (which does fall back to
// `server.getClientVersion()`); `server_health` re-resolved from `ctx.clientInfo`, which was never
// backfilled from that same fallback — so `tools/list` served the `domain` tools while
// `server_health.toolFacade` reported `{ effective: "triad" }` with no `clientName`, on the SAME
// connection, in the SAME process. The fix threads ONE resolved decision (`ctx.effectiveFacadeMode`)
// and ONE backfilled `ctx.clientInfo` through mcp/server.ts's `tools/call` handler; this test drives
// a REAL stdio-shaped connection (InMemoryTransport, a real `Client`, a real `createMcpServer` with
// a real `server_health` tool registered) end to end, the same way a real MCP client would.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { CallerContext } from "../src/mcp/registry";
import { ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { createHealthTool } from "../src/tools/admin/health";

function reg(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(
    createHealthTool({
      version: "test",
      vaults: ["v1"],
      startedAt: 0,
      nativeLoaded: false,
      vecEnabled: false,
      toolFacade: { configured: "auto" },
    }),
  );
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
  // No `era` passed (mirrors every other direct-construction test in this suite) — legacy, the
  // default `createMcpServer` serves when unset. `facadeMode: "auto"` with the built-in table
  // untouched by config, exactly as a real deployment ships it.
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
  const client = new Client({ name: clientName, version: "1.0" });
  await client.connect(ct);
  return { client, server };
}

function healthPayload(res: unknown): {
  toolFacade?: { configured: string; effective: string; clientName?: string };
} {
  const content = (res as { content: [{ text: string }] }).content;
  return JSON.parse(content[0].text);
}

describe("tools/list and server_health agree on the auto-resolved facade mode (THE-1123 review fix)", () => {
  it("a legacy 'claude-code' connection: tools/list serves domain tools AND server_health reports domain/claude-code", async () => {
    const { client, server } = await connectAs("claude-code");
    // tools/list, first — this is what seeds/uses the resolver's cache in the real bug report.
    // Domain mode over a registry with only `server_health` (domain: "admin") advertises exactly
    // one meta-tool, "admin" — never the triad's three, and never the bare tool name itself.
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["admin"]);

    const res = await client.callTool({ name: "server_health", arguments: {} });
    expect(res.isError).not.toBe(true);
    const payload = healthPayload(res);
    expect(payload.toolFacade).toEqual({
      configured: "auto",
      effective: "domain",
      clientName: "claude-code",
    });

    await client.close();
    await server.close();
  });

  it("an unrecognized client name: tools/list serves the triad AND server_health reports triad with no clientName leaking a wrong value", async () => {
    const { client, server } = await connectAs("some-unknown-client");
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["call_capability", "describe_capability", "find_capability"]);

    const res = await client.callTool({ name: "server_health", arguments: {} });
    expect(res.isError).not.toBe(true);
    const payload = healthPayload(res);
    expect(payload.toolFacade?.configured).toBe("auto");
    expect(payload.toolFacade?.effective).toBe("triad");
    // The client DID declare a name ("some-unknown-client") at `initialize`, so clientName is
    // still reported — it just didn't match any table entry. Unrecognized is not the same as
    // absent.
    expect(payload.toolFacade?.clientName).toBe("some-unknown-client");

    await client.close();
    await server.close();
  });
});
