// THE-271's DNS-rebinding / cross-origin guard, which had almost no coverage until THE-583 came to
// replace its internals with the SDK's `validateHostHeader` / `validateOriginHeader`.
//
// The missing tests mattered more than the refactor. The SDK matches on the HOSTNAME, while our
// config schema documents `allowedHosts` as "Host header values" — so an operator entry of
// `example.com:8765` matches nothing under the SDK's rules. That is not a subtle degradation: the
// guard runs before auth on every request, so it would 403 the entire deployment. Nothing in the
// suite would have caught it.
//
// This file pins the CONTRACT (which Hosts and Origins are accepted), not the implementation, so it
// stays honest across whatever validates them next.
import { request } from "node:http";
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { createHealthTool } from "../src/tools/admin/health";
import { startHttp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";

const AUTH: ServerConfig["auth"] = ServerConfigSchema.parse({
  vaults: [{ id: "v1", path: "/tmp/v1" }],
  auth: { mode: "none" },
}).auth;

async function boot(extra: { allowedHosts?: string[]; allowedOrigins?: string[] } = {}) {
  const db = openMemoryDb();
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
  return startHttp({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry,
    auth: AUTH,
    db,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    host: "127.0.0.1",
    port: 0,
    ...extra,
  });
}

/**
 * POST tools/list with an explicit Host (and optional Origin).
 *
 * `node:http` rather than `fetch`, and that is load-bearing: under Node — the vitest runtime —
 * `fetch` treats `Host` as a forbidden header and DROPS it silently. Measured: a request sent with
 * `headers: { host: "attacker.example" }` arrives with `Host: 127.0.0.1:<port>`. Every Host case in
 * this file would then have been exercising loopback and passing for the wrong reason, which is
 * precisely how a guard ends up with coverage that proves nothing.
 */
function post(port: number, headers: Record<string, string>): Promise<number> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
          "content-length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("DNS-rebinding guard — Host (THE-271, SDK-validated since THE-583)", () => {
  it("allows loopback without any configuration", async () => {
    const h = await boot();
    try {
      expect(await post(h.port, { host: `127.0.0.1:${h.port}` })).toBe(200);
      expect(await post(h.port, { host: `localhost:${h.port}` })).toBe(200);
    } finally {
      await h.close();
    }
  }, 20_000);

  it("rejects a non-loopback Host that was never allowed", async () => {
    // The floor. Without this, every "allowed" case below could be passing because the guard
    // accepts everything.
    const h = await boot();
    try {
      expect(await post(h.port, { host: "attacker.example" })).toBe(403);
    } finally {
      await h.close();
    }
  }, 20_000);

  it("honours an allowedHosts entry WITH a port — the documented 'Host header value' form", async () => {
    // The regression the SDK's hostname-only matching would have introduced. The config schema
    // says these are Host header values, and a Host header carries the port.
    const h = await boot({ allowedHosts: ["mcp.internal:8765"] });
    try {
      expect(await post(h.port, { host: "mcp.internal:8765" })).toBe(200);
    } finally {
      await h.close();
    }
  }, 20_000);

  it("honours an allowedHosts entry WITHOUT a port, whatever port the request carries", async () => {
    const h = await boot({ allowedHosts: ["mcp.internal"] });
    try {
      expect(await post(h.port, { host: "mcp.internal:9999" })).toBe(200);
      expect(await post(h.port, { host: "mcp.internal" })).toBe(200);
    } finally {
      await h.close();
    }
  }, 20_000);

  it("does not let an allowed host smuggle in a different one", async () => {
    // A prefix/suffix match would accept these; an exact hostname match must not.
    const h = await boot({ allowedHosts: ["mcp.internal"] });
    try {
      expect(await post(h.port, { host: "evil-mcp.internal" })).toBe(403);
      expect(await post(h.port, { host: "mcp.internal.evil.test" })).toBe(403);
    } finally {
      await h.close();
    }
  }, 20_000);
});

describe("DNS-rebinding guard — Origin (THE-271)", () => {
  it("rejects a cross-origin browser request", async () => {
    const h = await boot();
    try {
      expect(
        await post(h.port, { host: `127.0.0.1:${h.port}`, origin: "http://evil.example" }),
      ).toBe(403);
    } finally {
      await h.close();
    }
  }, 20_000);

  it("allows same-origin, and allows a configured origin", async () => {
    const h = await boot({ allowedOrigins: ["https://app.internal"] });
    try {
      expect(
        await post(h.port, {
          host: `127.0.0.1:${h.port}`,
          origin: `http://127.0.0.1:${h.port}`,
        }),
      ).toBe(200);
      expect(
        await post(h.port, { host: `127.0.0.1:${h.port}`, origin: "https://app.internal" }),
      ).toBe(200);
    } finally {
      await h.close();
    }
  }, 20_000);

  it("allows a request with NO Origin — server-to-server clients send none", async () => {
    // Browsers always send Origin; httpx/curl do not. Requiring it would break every real caller,
    // LiteLLM included.
    const h = await boot();
    try {
      expect(await post(h.port, { host: `127.0.0.1:${h.port}` })).toBe(200);
    } finally {
      await h.close();
    }
  }, 20_000);
});
