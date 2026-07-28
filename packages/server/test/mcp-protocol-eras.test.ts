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

/**
 * A MODERN (2026-07-28) request is not just "the same body with a header". SEP-2575 moved the
 * handshake into a per-request `_meta` envelope and SEP-2243 added routing headers the server
 * cross-checks against the body — so a modern call must carry ALL of:
 *
 *   * `Mcp-Method` (and `Mcp-Name` where the method names a thing) — the server rejects a request
 *     whose headers and body disagree, with -32020.
 *   * `_meta` carrying protocolVersion + clientInfo + clientCapabilities — a missing key is
 *     -32602 naming the key.
 *
 * Building it here rather than in each test is deliberate: every one of those requirements was
 * discovered by getting it wrong, and a helper keeps the tests about ERAS rather than about
 * envelope assembly.
 */
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "eras-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

async function post(
  port: number,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
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

/** A 2025-era call: bare body, version header only. This is what LiteLLM sends. */
const legacy = (port: number, body: unknown) =>
  post(port, body, { "mcp-protocol-version": LEGACY });

/** A 2026-era call: routing headers + the full `_meta` envelope. */
const modern = (
  port: number,
  method: string,
  params: Record<string, unknown> = {},
  name?: string,
) =>
  post(
    port,
    { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: MODERN_META } },
    { "mcp-protocol-version": MODERN, "mcp-method": method, ...(name ? { "mcp-name": name } : {}) },
  );

describe("protocol eras — one server serves 2025-11-25 and 2026-07-28 (THE-583)", () => {
  it("serves a LEGACY client: initialize negotiates 2025-11-25 and tools/list works", async () => {
    // The production path. LiteLLM pins `mcp` 1.28.1 and cannot speak anything newer.
    const h = await boot();
    try {
      const init = await legacy(h.port, {
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

      const list = await legacy(h.port, { jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect(list.status).toBe(200);
      expect(list.json.result?.tools?.map((t: { name: string }) => t.name)).toContain(
        "server_health",
      );
    } finally {
      await h.close();
    }
  }, 20_000);

  it("serves a MODERN client: server/discover replaces the handshake (SEP-2575)", async () => {
    // The handshake is GONE on this revision, so discover is how a client learns what it is
    // talking to. The spec makes it mandatory; hand-wiring Server+transport left it unreachable
    // (-32601) because a stateless connection never established an era — createMcpHandler is what
    // fixed that, and this asserts the fix rather than the handler merely being registered.
    const h = await boot();
    try {
      const d = await modern(h.port, "server/discover");
      expect(d.status).toBe(200);
      expect(d.json.error).toBeUndefined();
      expect(d.json.result.supportedVersions).toContain(MODERN);
      // Capabilities must mirror what the server actually serves, or discovery misleads.
      expect(d.json.result.capabilities).toHaveProperty("tools");
      expect(d.json.result._meta?.["io.modelcontextprotocol/serverInfo"]?.name).toBe("obsidian-tc");
    } finally {
      await h.close();
    }
  }, 20_000);

  it("serves a MODERN client: tools/call with NO initialize handshake", async () => {
    const h = await boot();
    try {
      const call = await modern(
        h.port,
        "tools/call",
        { name: "server_health", arguments: {} },
        "server_health",
      );
      expect(call.status).toBe(200);
      expect(call.json.error).toBeUndefined();
      // Stricter than "no error": a bad tool name returns a RESULT carrying isError.
      expect(call.json.result.isError).not.toBe(true);
      expect(JSON.stringify(call.json.result)).toContain("0.0.0-test");
    } finally {
      await h.close();
    }
  }, 20_000);

  it("enforces SEP-2243: a modern request whose headers and body disagree is refused", async () => {
    // The server rejects header/body mismatch rather than trusting either. Without this, the
    // routing headers would be decoration — a gateway could route on one method while the server
    // executed another.
    const h = await boot();
    try {
      const mismatched = await post(
        h.port,
        { jsonrpc: "2.0", id: 9, method: "tools/list", params: { _meta: MODERN_META } },
        { "mcp-protocol-version": MODERN, "mcp-method": "prompts/list" },
      );
      expect(mismatched.status).toBe(400);
      expect(JSON.stringify(mismatched.json)).toMatch(/disagree|mismatch/i);
    } finally {
      await h.close();
    }
  }, 20_000);

  it("enforces the SEP-2575 envelope: a missing _meta key is refused by name", async () => {
    const h = await boot();
    try {
      const noCaps = await post(
        h.port,
        {
          jsonrpc: "2.0",
          id: 10,
          method: "tools/list",
          params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } },
        },
        { "mcp-protocol-version": MODERN, "mcp-method": "tools/list" },
      );
      expect(noCaps.status).toBe(400);
      expect(JSON.stringify(noCaps.json)).toContain("clientCapabilities");
    } finally {
      await h.close();
    }
  }, 20_000);

  it("attaches SEP-2549 cache hints on MODERN only, scoped by caller-dependence", async () => {
    // `cacheScope` is a security decision: `public` lets a SHARED cache reuse one caller's response
    // for another. tools/list is filtered by grantedScopes, so it must be private; prompts/list is
    // the built-in templates with no filtering, so it is safely public.
    const h = await boot();
    try {
      const t = await modern(h.port, "tools/list");
      expect(t.json.result.ttlMs).toBeGreaterThan(0);
      expect(t.json.result.cacheScope).toBe("private");

      const p = await modern(h.port, "prompts/list");
      expect(p.json.result.cacheScope).toBe("public");

      // The 2025-11-25 wire schemas are frozen and never defined these fields.
      const l = await legacy(h.port, { jsonrpc: "2.0", id: 7, method: "tools/list" });
      expect(l.json.result.ttlMs).toBeUndefined();
      expect(l.json.result.cacheScope).toBeUndefined();
    } finally {
      await h.close();
    }
  }, 20_000);

  it("does not answer an UNKNOWN future revision — the advertised set is finite", async () => {
    // The floor. If the server accepted anything at all, every case above would prove nothing
    // about era negotiation.
    const h = await boot();
    try {
      const r = await post(
        h.port,
        { jsonrpc: "2.0", id: 4, method: "tools/list" },
        { "mcp-protocol-version": "2099-01-01" },
      );
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.json)).toContain("2099-01-01");
    } finally {
      await h.close();
    }
  }, 20_000);
});
