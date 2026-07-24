// THE-561 regression harness — MUST run under Bun (`bun test/http-keepalive-reuse.bun.ts`).
//
// Boots the REAL startHttp and hammers a single REUSED keep-alive connection, exactly the way
// LiteLLM's httpx pool does. Under Bun, @hono/node-server's Node-compat http.Server dropped
// ~25% of reused-connection requests with ECONNRESET (fresh connections were 100%). This is NOT
// a vitest test on purpose: vitest runs under Node, where the bug does not exist, so a Node test
// would pass against the broken code — a green check that cannot see the defect. Run under Bun.
//
// Exit 0 = all calls succeeded. Exit 1 = at least one reused-connection call failed.
import http from "node:http";
import { FolderAcl } from "../src/acl";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { createHealthTool } from "../src/tools/admin/health";
import { startHttp } from "../src/transports/http";

const db = await openDatabase(":memory:");
provisionCacheDb(db);
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
  auth: { mode: "none" } as never,
  db,
  vaultId: "v1",
  acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
  host: "127.0.0.1",
  port: 0,
});

const PORT = handle.port;

function call(agent: http.Agent, i: number): Promise<[boolean, string]> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: i,
      method: "tools/call",
      params: { name: "server_health", arguments: {}, _meta: { progressToken: i } },
    });
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: "/mcp",
        method: "POST",
        agent,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (x) => (d += x));
        res.on("end", () => resolve([res.statusCode === 200, String(res.statusCode)]));
      },
    );
    req.on("error", (e: NodeJS.ErrnoException) => resolve([false, e.code ?? e.message]));
    req.end(payload);
  });
}

const N = 40;
// One socket, keep-alive on -> forces connection reuse, mimicking a pooling client.
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
const results: [boolean, string][] = [];
for (let i = 0; i < N; i++) results.push(await call(agent, i + 1));
agent.destroy();
await handle.close();
db.close?.();

const ok = results.filter(([o]) => o).length;
const marks = results.map(([o]) => (o ? "." : "X")).join("");
const fails = [...new Set(results.filter(([o]) => !o).map(([, d]) => d))];
process.stdout.write(`reused keep-alive connection: ${ok}/${N}  ${marks}\n`);
if (fails.length) process.stdout.write(`  failures: ${fails.join(", ")}\n`);
process.exit(ok === N ? 0 : 1);
