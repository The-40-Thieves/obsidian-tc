import { performance } from "node:perf_hooks";
import { FolderAcl } from "../../../src/acl";
import { ToolRegistry } from "../../../src/mcp/registry";
import { createHttpApp } from "../../../src/transports/http";
import type { VaultCtx } from "../harness";
import type { MetricSample } from "../report";

/**
 * Family 12 — HTTP cold/warm handshake (THE-495).
 *
 * Measures the cost of an MCP `initialize` round-trip through the real HTTP app. That is the
 * interesting number because `transports/http.ts` assembles a FRESH MCP server + transport per
 * request; this is the profile THE-463 (cache immutable MCP protocol products) wants to move.
 *
 * NO NETWORK LISTENER, by requirement. Hono's `app.fetch(Request)` runs the entire request
 * pipeline in-process — routing, the DNS-rebinding guard, auth resolution, the per-request server
 * construction, transport handling and teardown — so the handshake is exercised end to end
 * without binding a port. A listener would add accept/TCP noise to the very measurement we want
 * and make the harness fight for ports in CI.
 *
 * Cold vs warm: the FIRST request pays one-time costs (module-level lazy init, JIT warmup, SDK
 * setup) that later requests do not. Reporting them separately keeps a regression in steady-state
 * handling from being masked by startup noise, and vice versa.
 */
export async function collectHttp(vault: VaultCtx): Promise<MetricSample[]> {
  const app = createHttpApp({
    name: "obsidian-tc-perf",
    version: "0.0.0-perf",
    registry: new ToolRegistry(),
    // auth "none" is safe here precisely because nothing is ever bound: the config schema's
    // fail-closed rule (no unauthenticated server on a non-loopback host) governs real servers.
    // Using jwt would measure token verification, which belongs to a different family.
    auth: { mode: "none" } as Parameters<typeof createHttpApp>[0]["auth"],
    db: vault.db,
    vaultId: vault.vaultId,
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
  } as Parameters<typeof createHttpApp>[0]);

  const initialize = (): Request =>
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        // A constructed Request carries no Host header, and the DNS-rebinding guard runs BEFORE
        // auth — without this the app answers 403 "host not allowed" and the handshake measures
        // a rejection instead of a protocol round-trip. Set it rather than disabling the guard:
        // the guard is part of the per-request cost this family exists to measure.
        host: "127.0.0.1",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "perf-harness", version: "1" },
        },
      }),
    });

  /** One full handshake; returns elapsed ms and whether the protocol actually answered. */
  const handshake = async (): Promise<{ ms: number; ok: boolean }> => {
    const t = performance.now();
    let ok = false;
    try {
      const res = await app.fetch(initialize());
      const body = await res.text();
      // A 2xx alone is not proof: an error envelope is also 200 in some paths. Require the
      // protocol-level result so a silently degraded handshake cannot pass the hard gate.
      ok = res.ok && body.includes('"result"') && body.includes("protocolVersion");
    } catch {
      ok = false;
    }
    return { ms: performance.now() - t, ok };
  };

  const cold = await handshake();
  const warm = await handshake();

  return [
    {
      key: "http.handshake_ok",
      value: cold.ok && warm.ok ? 1 : 0,
      unit: "bool",
      class: "hard",
      direction: "exact",
    },
    { key: "http.cold_ms", value: cold.ms, unit: "ms", class: "warn", direction: "higher-worse" },
    { key: "http.warm_ms", value: warm.ms, unit: "ms", class: "warn", direction: "higher-worse" },
  ];
}

/**
 * THE-503 Part 2 scenario coverage — concurrent HTTP callers (2 and 8). The single-caller
 * cold/warm handshake above says nothing about what happens when several MCP clients hit the
 * same server at once; `transports/http.ts` builds a fresh server+transport PER REQUEST (the
 * profile THE-463 targets), so concurrent requests are also a concurrency-safety question, not
 * just a throughput one. Reuses the same in-process `app.fetch()` approach — no network
 * listener, no port contention.
 */
async function fireConcurrentHandshakes(
  app: ReturnType<typeof createHttpApp>,
  initialize: () => Request,
  concurrency: number,
): Promise<{ ms: number; okCount: number }[]> {
  const calls = Array.from({ length: concurrency }, async () => {
    const t = performance.now();
    let ok = false;
    try {
      const res = await app.fetch(initialize());
      const body = await res.text();
      ok = res.ok && body.includes('"result"') && body.includes("protocolVersion");
    } catch {
      ok = false;
    }
    return { ms: performance.now() - t, ok };
  });
  const results = await Promise.all(calls);
  return results.map((r) => ({ ms: r.ms, okCount: r.ok ? 1 : 0 }));
}

export async function collectHttpConcurrency(vault: VaultCtx): Promise<MetricSample[]> {
  const app = createHttpApp({
    name: "obsidian-tc-perf",
    version: "0.0.0-perf",
    registry: new ToolRegistry(),
    auth: { mode: "none" } as Parameters<typeof createHttpApp>[0]["auth"],
    db: vault.db,
    vaultId: vault.vaultId,
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
  } as Parameters<typeof createHttpApp>[0]);

  const initialize = (): Request =>
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        host: "127.0.0.1",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "perf-harness-concurrent", version: "1" },
        },
      }),
    });

  // One warmup round per level, not measured, so cold-start cost doesn't leak into the reported
  // latency (that is what http.cold_ms/warm_ms already isolate above).
  await fireConcurrentHandshakes(app, initialize, 2);

  const samples: MetricSample[] = [];
  for (const concurrency of [2, 8] as const) {
    const results = await fireConcurrentHandshakes(app, initialize, concurrency);
    const okCount = results.reduce((a, r) => a + r.okCount, 0);
    const ms = results.map((r) => r.ms).sort((a, b) => a - b);
    const p99 = ms[Math.min(ms.length - 1, Math.floor(0.99 * ms.length))] as number;
    samples.push(
      {
        key: `http.concurrent${concurrency}_ok_count`,
        value: okCount,
        unit: "count",
        class: "hard",
        direction: "exact",
      },
      {
        key: `http.concurrent${concurrency}_p99_ms`,
        value: p99,
        unit: "ms",
        class: "warn",
        direction: "higher-worse",
      },
    );
  }
  return samples;
}
