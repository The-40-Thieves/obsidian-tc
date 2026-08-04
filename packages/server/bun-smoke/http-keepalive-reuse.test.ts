// THE-561 regression: @hono/node-server's Node-compat http.Server dropped ~25% of requests sent
// over a REUSED keep-alive connection under Bun, with ECONNRESET. Fresh connections were 100%, so
// nothing that opened a socket per call could see it — and LiteLLM's httpx pool reuses, which is
// how it surfaced as "the gateway drops a quarter of tool calls".
//
// In bun-smoke and not vitest because the defect exists only under Bun: vitest runs under Node,
// where the bug is absent, so a vitest version would pass against the broken code —
// measures-nothing-while-green, the shape bun-smoke exists to catch. Same reasoning as
// dual-http-servers.test.ts, which sits beside it.
//
// THE-730: this used to live at `test/http-keepalive-reuse.bun.ts` and **no runner invoked it**.
// vitest's `include` is `test/**/*.test.ts`, which a `.bun.ts` suffix does not match, and CI's
// `bun test bun-smoke` filter is a path substring that only reaches `bun-smoke/`. It fell through
// both for two independent reasons, which is why neither owner noticed. A comment in
// transports/http.ts named it alongside dual-http-servers.test.ts as though the two were
// equivalently wired; only the second one ran. A test file existing is not a test running.
import { expect, test } from "bun:test";
import http from "node:http";
import { FolderAcl } from "../src/acl";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { createHealthTool } from "../src/tools/admin/health";
import { startHttp } from "../src/transports/http";

/** One request over `agent`. Resolves [ok, detail] rather than rejecting, so a transport-level
 *  ECONNRESET is counted as a failed call instead of aborting the loop — the whole point is to
 *  measure HOW MANY of N reused-connection calls survive, not to stop at the first casualty. */
function call(agent: http.Agent, port: number, i: number): Promise<[boolean, string]> {
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
        port,
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
        res.on("data", () => {});
        res.on("end", () => resolve([res.statusCode === 200, String(res.statusCode)]));
      },
    );
    req.on("error", (e: NodeJS.ErrnoException) => resolve([false, e.code ?? e.message]));
    req.end(payload);
  });
}

test("every request on a REUSED keep-alive connection succeeds", async () => {
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

  const N = 40;
  // maxSockets: 1 + keepAlive is the load-bearing part: it forces every call onto ONE socket, which
  // is what a pooling client does and the only condition under which the defect appears. Raising
  // maxSockets or dropping keepAlive makes this pass against broken code.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const results: [boolean, string][] = [];
  try {
    for (let i = 0; i < N; i++) results.push(await call(agent, handle.port, i + 1));
  } finally {
    agent.destroy();
    await handle.close();
    db.close?.();
  }

  const ok = results.filter(([o]) => o).length;
  if (ok !== N) {
    // Printed only on failure, and it is the diagnostic that made THE-561 legible: the marks show
    // WHERE in the sequence the drops fall (a run of X's late in the string reads very differently
    // from scattered ones), and the deduped codes distinguish ECONNRESET from an HTTP-level refusal.
    const marks = results.map(([o]) => (o ? "." : "X")).join("");
    const codes = [...new Set(results.filter(([o]) => !o).map(([, d]) => d))].join(", ");
    process.stdout.write(
      `reused keep-alive connection: ${ok}/${N}  ${marks}\n  failures: ${codes}\n`,
    );
  }
  expect(ok).toBe(N);
});
