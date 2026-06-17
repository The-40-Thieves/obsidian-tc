import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { type CallerContext, ToolRegistry } from "../src/mcp/registry";
import { createMcpServer } from "../src/mcp/server";
import { createHealthTool } from "../src/tools/admin/health";
import { openMemoryDb } from "./helpers";

const schemaSql = readFileSync(
  fileURLToPath(new URL("../src/schema.sql", import.meta.url)),
  "utf8",
);
describe("mcp transport round-trip", () => {
  it("server_health round-trips transport -> dispatch -> audit", async () => {
    const db = openMemoryDb();
    db.exec(schemaSql);

    const registry = new ToolRegistry();
    registry.register(
      createHealthTool({ version: "0.0.0-test", vaults: ["v1"], startedAt: Date.now() }),
    );

    const context = (): CallerContext => ({
      caller: "stdio",
      authenticated: true,
      grantedScopes: new Set(["*"]),
      vaultId: "v1",
      db,
    });

    const server = createMcpServer({
      name: "obsidian-tc",
      version: "0.0.0-test",
      registry,
      context,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toContain("server_health");

    const res = await client.callTool({ name: "server_health", arguments: {} });
    expect(res.isError).toBeFalsy();

    const content = res.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0]?.text ?? "null");
    expect(payload.status).toBe("ok");
    expect(payload.name).toBe("obsidian-tc");

    const rows = db.prepare("SELECT tool_name, status FROM event_log").all() as Array<{
      tool_name: string;
      status: string;
    }>;
    expect(rows.some((r) => r.tool_name === "server_health" && r.status === "ok")).toBe(true);

    await client.close();
    await server.close();
  });
});
