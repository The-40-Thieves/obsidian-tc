// THE-659: the MCP transport and the Prometheus /metrics endpoint must survive running in the SAME
// process. They did not, and the failure was total and silent.
//
// `metrics/endpoint.ts` served its app with `@hono/node-server` while THE-561 had already moved the
// MCP transport to native `Bun.serve`. Starting the Node-compat server installs its HTTP machinery
// process-wide, after which Hono's responses are the "lightweight" variant that `Bun.serve`
// refuses, and Bun answers with its own placeholder page instead:
//
//     Welcome to Bun! To get started, return a Response object.
//
// at **HTTP 200**. So `observability.prometheus.enabled: true` took the entire MCP plane down while
// every status-code health check stayed green. This is asserted on the BODY, not the status, for
// exactly that reason.
//
// In bun-smoke and not vitest because the defect exists only under Bun: vitest runs under Node,
// where both paths are the same Node server and nothing breaks. A vitest version of this test would
// pass against the broken code — measures-nothing-while-green, the shape bun-smoke exists to catch.
//
// The order below is PRODUCTION's order (cli.ts starts http, then metrics). Starting the
// Node-compat server second is what poisoned the already-listening Bun.serve, so a test that
// started metrics first would not reproduce the outage.
import { expect, test } from "bun:test";
import { FolderAcl } from "../src/acl";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { startMetricsEndpoint } from "../src/metrics/endpoint";
import { MetricsRecorder } from "../src/metrics/registry";
import { createHealthTool } from "../src/tools/admin/health";
import { startHttp } from "../src/transports/http";

const BUN_PLACEHOLDER = "Welcome to Bun!";

test("MCP and /metrics both serve real responses from one process", async () => {
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

  const http = await startHttp({
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

  // Second listener, exactly as cli.ts adds it when prometheus is enabled.
  const metrics = await startMetricsEndpoint({
    recorder: new MetricsRecorder(),
    bind: "127.0.0.1",
    port: 0,
    auth: { mode: "none" } as never,
  });

  try {
    // GET /mcp is 405 in stateless mode — a real, route-matched Hono response. Under the defect
    // this came back 200 with Bun's placeholder, so assert the body, then the status.
    const mcpRes = await fetch(`http://127.0.0.1:${http.port}/mcp`);
    const mcpBody = await mcpRes.text();
    expect(mcpBody).not.toContain(BUN_PLACEHOLDER);
    expect(mcpRes.status).toBe(405);
    expect(JSON.parse(mcpBody).error.message).toContain("stateless");

    // An unrouted path must produce Hono's own 404 rather than the placeholder: the rejected object
    // in the incident WAS a 404, so a server that 404s correctly is the thing being proven.
    const missingRes = await fetch(`http://127.0.0.1:${http.port}/nope`);
    expect(await missingRes.text()).not.toContain(BUN_PLACEHOLDER);
    expect(missingRes.status).toBe(404);

    // And the metrics endpoint itself still works — the fix must not trade one server for the other.
    const metricsRes = await fetch(`http://127.0.0.1:${metrics.port}/metrics`);
    const metricsBody = await metricsRes.text();
    expect(metricsBody).not.toContain(BUN_PLACEHOLDER);
    expect(metricsRes.status).toBe(200);
    // A non-empty floor: an exposition that scraped nothing would pass every assertion above.
    expect(metricsBody).toContain("obsidian_tc");
  } finally {
    await http.close();
    await metrics.close();
    db.close();
  }
});
