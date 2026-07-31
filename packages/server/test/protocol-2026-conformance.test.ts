// THE-583: the 2026-07-28 conformance floor, asserted ON THE WIRE.
//
// Every other test here proves one feature works. This one exists to answer a different question —
// "do we satisfy the revision?" — and it answers it against the changelog rather than against
// recollection. Each case names the change it pins so a future reader can check the claim without
// trusting this comment.
//
// The removals matter as much as the additions: a method the revision deleted, still answered, is a
// conformance failure that no feature test would ever notice.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServerConfig, ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { JobQueue } from "../src/scheduler/job-queue";
import { createHealthTool } from "../src/tools/admin/health";
import { type HttpHandle, startHttp } from "../src/transports/http";
import { VaultRegistry } from "../src/vault/registry";
import { openMemoryDb } from "./helpers";
import { rmTemp } from "./tmp";

const SECRET = "test-only-secret-not-a-real-credential-0123456789";
const MODERN = "2026-07-28";

let handle: HttpHandle;
let jwt: string;
/**
 * A real vault the TEST creates. An earlier version pointed at a `/tmp/...` directory made by hand
 * outside the suite: green locally, red on all four CI runners — and doubly wrong on Windows, which
 * has no `/tmp` at all. A fixture a test depends on but does not create is not a fixture.
 */
let vaultRoot: string;

beforeAll(async () => {
  vaultRoot = mkdtempSync(join(tmpdir(), "obsidian-tc-conf-"));
  writeFileSync(join(vaultRoot, "note.md"), "---\ntitle: X\n---\n\nbody\n");
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
    auth: { mode: "jwt", jwtSecret: SECRET, audience: "http://test", tokenTtlSeconds: 3600 },
  }).auth;
  handle = await startHttp({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry,
    auth,
    db,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    host: "127.0.0.1",
    port: 0,
    jobQueue: new JobQueue(db),
    // The real class, not a hand-rolled stub — a stub is how three of these "failed" as a mock bug.
    vaultRegistry: new VaultRegistry([{ id: "v1", path: vaultRoot }]),
  });
  const now = Math.floor(Date.now() / 1000);
  jwt = await new SignJWT({ sub: "a", scopes: ["*"], aud: "http://test", iat: now, exp: now + 600 })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(new TextEncoder().encode(SECRET));
}, 30_000);

afterAll(async () => {
  await handle?.close();
  if (vaultRoot) rmTemp(vaultRoot);
});

/** One modern JSON-RPC call. `name` fills the SEP-2243 Mcp-Name header when the method needs it. */
async function rpc(
  method: string,
  params: Record<string, unknown> = {},
  name?: string,
): Promise<{ status: number; headers: Headers; body: any }> {
  const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${jwt}`,
      "mcp-protocol-version": MODERN,
      "mcp-method": method,
      ...(name === undefined ? {} : { "mcp-name": name }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientInfo": { name: "conformance", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return {
    status: res.status,
    headers: res.headers,
    body: JSON.parse(line ? line.slice(6) : text || "{}"),
  };
}

describe("SEP-2567 — protocol sessions are gone", () => {
  it("never issues an Mcp-Session-Id", async () => {
    const r = await rpc("tools/list");
    expect(r.headers.get("mcp-session-id")).toBeNull();
    expect(r.body.error).toBeUndefined();
  }, 20_000);

  it("serves a request that carries no session header at all", async () => {
    // The whole point of statelessness: no prior exchange is required.
    const r = await rpc("tools/list");
    expect(Array.isArray(r.body.result?.tools)).toBe(true);
  }, 20_000);
});

describe("SEP-2575 — removed methods stay removed", () => {
  // A method the revision deleted, still answered, is a conformance failure no feature test notices.
  for (const method of ["ping", "logging/setLevel", "initialize"]) {
    it(`refuses ${method}`, async () => {
      const r = await rpc(method, method === "logging/setLevel" ? { level: "debug" } : {});
      expect(r.body.result).toBeUndefined();
      expect(r.body.error).toBeDefined();
    }, 20_000);
  }
});

describe("SEP-2575 — server/discover replaces the handshake", () => {
  it("advertises versions, capabilities and the tasks extension", async () => {
    const r = await rpc("server/discover");
    expect(r.body.error).toBeUndefined();
    expect(r.body.result.supportedVersions).toContain(MODERN);
    expect(r.body.result.capabilities).toBeDefined();
    expect(r.body.result.capabilities.extensions["io.modelcontextprotocol/tasks"]).toBeDefined();
  }, 20_000);

  it("declares listChanged, without which a subscription filter is silently empty", async () => {
    const r = await rpc("server/discover");
    expect(r.body.result.capabilities.tools.listChanged).toBe(true);
    expect(r.body.result.capabilities.prompts.listChanged).toBe(true);
  }, 20_000);
});

describe("SEP-2322 — every result carries resultType", () => {
  it('tags an ordinary result "complete"', async () => {
    const r = await rpc("tools/list");
    expect(r.body.result.resultType).toBe("complete");
  }, 20_000);
});

describe("SEP-2549 — cacheable results carry ttlMs and cacheScope", () => {
  // The spec names five. Testing one and generalising is how four go missing.
  const cases: Array<[string, Record<string, unknown>, string | undefined]> = [
    ["tools/list", {}, undefined],
    ["prompts/list", {}, undefined],
    ["resources/list", {}, undefined],
    ["resources/templates/list", {}, undefined],
    ["resources/read", { uri: "obsidian-tc://v1/note.md" }, "obsidian-tc://v1/note.md"],
  ];
  for (const [method, params, name] of cases) {
    it(`${method} carries both`, async () => {
      const r = await rpc(method, params, name);
      expect(r.body.error).toBeUndefined();
      expect(typeof r.body.result.ttlMs).toBe("number");
      expect(["public", "private"]).toContain(r.body.result.cacheScope);
    }, 20_000);
  }

  it("keeps prompts PUBLIC and tools PRIVATE — cacheScope is a security decision", async () => {
    // tools/list is filtered by grantedScopes, so a shared cache reusing one caller's response for
    // another is a scope leak. prompts/list is identical for every caller.
    const tools = await rpc("tools/list");
    const prompts = await rpc("prompts/list");
    expect(tools.body.result.cacheScope).toBe("private");
    expect(prompts.body.result.cacheScope).toBe("public");
  }, 20_000);
});

describe("SEP-2243 — required request headers", () => {
  it("rejects a body/header mismatch with the RENUMBERED code -32020", async () => {
    // The 2026 error-allocation policy moved HeaderMismatch from -32001 to -32020.
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${jwt}`,
        "mcp-protocol-version": MODERN,
        "mcp-method": "tools/call",
        // Mcp-Name deliberately absent while the body names a tool.
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "health",
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MODERN,
            "io.modelcontextprotocol/clientInfo": { name: "c", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const body = (await res.json()) as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32020);
  }, 20_000);
});

describe("SEP-2575 — SSE resumability was removed", () => {
  it("does not advertise a resumable stream (no Last-Event-ID contract)", async () => {
    // A broken stream loses the in-flight request; clients re-issue with a new id. Emitting SSE
    // event ids would advertise a redelivery guarantee this revision deleted.
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${jwt}`,
        "mcp-protocol-version": MODERN,
        "mcp-method": "tools/list",
        "last-event-id": "42",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MODERN,
            "io.modelcontextprotocol/clientInfo": { name: "c", version: "1" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    const text = await res.text();
    // The request is served normally; the header is simply not a resumption cursor.
    expect(text).toContain('"result"');
    expect(text).not.toMatch(/^id: /m);
  }, 20_000);
});

describe("2025 clients keep working (dual-era)", () => {
  it("serves a 2025-11-25 tools/list unchanged", async () => {
    // LiteLLM's client ceilings at 2025-11-25. Breaking it is not an option.
    const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${jwt}`,
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    const body = JSON.parse(line ? line.slice(6) : text);
    expect(Array.isArray(body.result?.tools)).toBe(true);
  }, 20_000);
});
