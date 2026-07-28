// THE-583: this server speaks BOTH protocol revisions, and that is a promise, not an accident.
//
// The 2026-07-28 spec removed the initialize/initialized handshake (SEP-2575) and sessions
// (SEP-2567). SDK v2 ships a frozen 2025-11-25 wire codec beside the 2026 one and picks per
// connection — but the shipped `SUPPORTED_PROTOCOL_VERSIONS` is 2025-era ONLY, so modern is opt-in
// and a plain v2 server answers a 2026 client with `400 Unsupported protocol version`.
//
// Two things make this worth a test rather than a comment:
//
//   * LOSING LEGACY IS AN OUTAGE. LiteLLM, the gateway in front of production, pins `mcp` 1.28.1
//     whose ceiling is 2025-11-25. If the legacy era ever stops being served, the MCP plane goes
//     dark — the THE-659 failure shape, self-inflicted.
//   * LOSING MODERN IS SILENT. The opt-in lives in ServerOptions, and `Server.connect()` overwrites
//     the transport's copy with the server's. Move it to the transport and everything still starts,
//     every existing test still passes, and the server is quietly legacy-only again.
//
// Raw JSON-RPC rather than an SDK Client, deliberately: the v1 client can only produce 2025-era
// traffic and the v2 client only speaks to what it negotiates, so neither can assert BOTH eras.
// The wire is the contract here.
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { createHealthTool } from "../src/tools/admin/health";
import { startHttp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";

const LEGACY = "2025-11-25"; // LiteLLM's ceiling — production depends on this one
const MODERN = "2026-07-28";

async function boot() {
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
  const auth: ServerConfig["auth"] = ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: "/tmp/v1" }],
    auth: { mode: "none" },
  }).auth;
  return startHttp({
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
}

/** POST one JSON-RPC message and return {status, body}; unwraps an SSE `data:` frame. */
async function rpc(
  port: number,
  body: unknown,
  protocolVersion?: string,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const payload = line ? line.slice(6) : text;
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

describe("protocol eras — one server serves 2025-11-25 and 2026-07-28 (THE-583)", () => {
  it("serves a LEGACY client: initialize negotiates 2025-11-25 and tools/list works", async () => {
    // This is the production path. LiteLLM cannot speak anything newer.
    const h = await boot();
    try {
      const init = await rpc(h.port, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LEGACY,
          capabilities: {},
          clientInfo: { name: "litellm-sim", version: "1.28.1" },
        },
      });
      expect(init.status).toBe(200);
      expect(init.json.result?.protocolVersion).toBe(LEGACY);

      const list = await rpc(h.port, { jsonrpc: "2.0", id: 2, method: "tools/list" }, LEGACY);
      expect(list.status).toBe(200);
      expect(list.json.result?.tools?.map((t: { name: string }) => t.name)).toContain(
        "server_health",
      );
    } finally {
      await h.close();
    }
  }, 20_000);

  it("serves a MODERN client: tools/call with NO initialize handshake", async () => {
    // SEP-2575 removed the handshake outright. A 2026 client opens with a real request, and a
    // server that still demanded initialize would reject it.
    const h = await boot();
    try {
      const call = await rpc(
        h.port,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "server_health", arguments: {} },
        },
        MODERN,
      );
      expect(call.status).toBe(200);
      // Not merely "not an error": the tool actually ran.
      expect(call.json.error).toBeUndefined();
      expect(call.json.result).toBeDefined();
      // Stricter than "no error": a bad tool name returns a RESULT carrying isError, which the two
      // assertions above would happily accept. The tool has to have actually run.
      expect(call.json.result.isError).not.toBe(true);
      expect(JSON.stringify(call.json.result)).toContain("0.0.0-test");
    } finally {
      await h.close();
    }
  }, 20_000);

  it("does not answer an UNKNOWN future revision — the advertised set is finite", async () => {
    // The floor that stops this suite passing vacuously. If the server accepted anything at all,
    // the two tests above would prove nothing about era negotiation. A version we never advertised
    // must be refused, and refused with the version named.
    const h = await boot();
    try {
      const r = await rpc(h.port, { jsonrpc: "2.0", id: 4, method: "tools/list" }, "2099-01-01");
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.json)).toContain("2099-01-01");
    } finally {
      await h.close();
    }
  }, 20_000);
  it("attaches SEP-2549 cache hints on MODERN only, and scopes them by caller-dependence", async () => {
    // `cacheScope` is a security decision: `public` lets a SHARED cache reuse one caller's response
    // for another. tools/list is filtered by grantedScopes, so it must be private; prompts/list is
    // the built-in templates with no filtering, so it is safely public.
    const h = await boot();
    try {
      const modern = await rpc(h.port, { jsonrpc: "2.0", id: 5, method: "tools/list" }, MODERN);
      expect(modern.json.result.ttlMs).toBeGreaterThan(0);
      expect(modern.json.result.cacheScope).toBe("private");

      const prompts = await rpc(h.port, { jsonrpc: "2.0", id: 6, method: "prompts/list" }, MODERN);
      expect(prompts.json.result.cacheScope).toBe("public");

      // The 2025-11-25 wire schemas are frozen and never defined these fields. Emitting them at a
      // legacy client would put a 2026-only shape on a revision that does not know it.
      const legacy = await rpc(h.port, { jsonrpc: "2.0", id: 7, method: "tools/list" }, LEGACY);
      expect(legacy.json.result.ttlMs).toBeUndefined();
      expect(legacy.json.result.cacheScope).toBeUndefined();
    } finally {
      await h.close();
    }
  }, 20_000);

  it("PINS THE GAP: server/discover is still -32601 (SEP-2575 not yet reachable)", async () => {
    // A handler for `server/discover` IS registered, but the SDK routes by the era the CONNECTION
    // was classified as, and stateless-per-request leaves that undefined -> the 2025 wire registry,
    // which has no such method. This asserts the CURRENT broken state deliberately: when the era
    // wiring is fixed this test fails, which is the notification that the gap closed. Without it,
    // a registered-but-unreachable handler reads as conformance forever.
    const h = await boot();
    try {
      const d = await rpc(h.port, { jsonrpc: "2.0", id: 8, method: "server/discover" }, MODERN);
      expect(d.json.error?.code).toBe(-32601);
    } finally {
      await h.close();
    }
  }, 20_000);
});
