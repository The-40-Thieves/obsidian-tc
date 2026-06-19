import { describe, expect, it } from "vitest";
import { createMetricsApp, startMetricsEndpoint } from "../src/metrics/endpoint";
import { MetricsRecorder } from "../src/metrics/registry";

describe("/metrics endpoint (THE-211)", () => {
  it("serves the catalog on a loopback bind with no auth", async () => {
    const app = createMetricsApp({
      recorder: new MetricsRecorder(),
      bind: "127.0.0.1",
      port: 0,
      auth: { mode: "none", tokenTtlSeconds: 86400 },
    });
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("# TYPE obsidian_tc_tool_calls_total counter");
  });

  it("requires a bearer token on a non-loopback bind (jwt mode)", async () => {
    const app = createMetricsApp({
      recorder: new MetricsRecorder(),
      bind: "0.0.0.0",
      port: 0,
      auth: { mode: "jwt", jwtSecret: "x".repeat(32), tokenTtlSeconds: 86400 },
    });
    const res = await app.request("/metrics");
    expect(res.status).toBe(401);
  });

  it("refuses to bind a non-loopback address under auth.mode none (hardcoded floor)", () => {
    expect(() =>
      startMetricsEndpoint({
        recorder: new MetricsRecorder(),
        bind: "0.0.0.0",
        port: 0,
        auth: { mode: "none", tokenTtlSeconds: 86400 },
      }),
    ).toThrow(/non-localhost/);
  });
});
