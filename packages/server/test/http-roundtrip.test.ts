import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { ToolRegistry } from "../src/mcp/registry";
import { createHealthTool } from "../src/tools/admin/health";
import { startHttp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";

const schemaSql = readFileSync(
  fileURLToPath(new URL("../src/schema.sql", import.meta.url)),
  "utf8",
);

function authOf(input: unknown): ServerConfig["auth"] {
  return ServerConfigSchema.parse({ vaults: [{ id: "v1", path: "/tmp/v1" }], auth: input }).auth;
}

async function boot(auth: ServerConfig["auth"]) {
  const db = openMemoryDb();
  db.exec(schemaSql);
  const registry = new ToolRegistry();
  registry.register(
    createHealthTool({
      version: "0.0.0-test",
      vaults: ["v1"],
      startedAt: Date.now(),
      nativeLoaded: false,
      vecEnabled: false,
    }),
  );
  const handle = await startHttp({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry,
    auth,
    db,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    host: "127.0.0.1",
    port: 0,
  });
  return { db, handle, url: new URL(`http://127.0.0.1:${handle.port}/mcp`) };
}

async function signed(secret: string, claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("alice")
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(secret));
}

describe("mcp streamable http transport", () => {
  it("round-trips a tool call over HTTP in auth mode none and audits it", async () => {
    const { db, handle, url } = await boot(authOf({ mode: "none" }));
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(url));

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("server_health");

    const res = await client.callTool({ name: "server_health", arguments: {} });
    expect(res.isError ?? false).toBe(false);

    const row = db.prepare("SELECT COUNT(*) AS n FROM event_log").get() as { n: number };
    expect(row.n).toBeGreaterThan(0);

    await client.close();
    await handle.close();
  });

  it("accepts a valid HS256 token and uses its scopes", async () => {
    const secret = "s".repeat(40);
    const { handle, url } = await boot(authOf({ mode: "jwt", jwtSecret: secret }));
    const token = await signed(secret, { scope: "*" });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );

    const res = await client.callTool({ name: "server_health", arguments: {} });
    expect(res.isError ?? false).toBe(false);

    await client.close();
    await handle.close();
  });

  it("rejects a request with no token in jwt mode", async () => {
    const { handle, url } = await boot(authOf({ mode: "jwt", jwtSecret: "s".repeat(40) }));
    const client = new Client({ name: "test", version: "0.0.0" });
    await expect(client.connect(new StreamableHTTPClientTransport(url))).rejects.toThrow();
    await handle.close();
  });

  it("rejects a token signed with the wrong secret", async () => {
    const { handle, url } = await boot(authOf({ mode: "jwt", jwtSecret: "s".repeat(40) }));
    const token = await signed("w".repeat(40), { scope: "*" });
    const client = new Client({ name: "test", version: "0.0.0" });
    await expect(
      client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      ),
    ).rejects.toThrow();
    await handle.close();
  });

  it("rejects a cross-origin browser request; allows same-origin server-to-server (THE-271)", async () => {
    const { handle, url } = await boot(authOf({ mode: "none" }));
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const accept = "application/json, text/event-stream";
    const evil = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept, origin: "http://evil.example" },
      body,
    });
    expect(evil.status).toBe(403);
    const ok = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept },
      body,
    });
    expect(ok.status).toBe(200);
    await handle.close();
  });
});
