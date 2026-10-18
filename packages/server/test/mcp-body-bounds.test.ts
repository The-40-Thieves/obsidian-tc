// /mcp reads the body itself before the MCP handler sees it. That read has to carry the MCP SDK's
// request-body limit: when the handler is handed `parsedBody`, the SDK never reads (or bounds) the
// body, so an oversized authenticated POST used to be parsed in full and accepted.
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { createHttpApp, type HttpApp } from "../src/transports/http";
import { openMemoryDb } from "./helpers";

const JWT_SECRET = "test-only-secret-not-a-real-credential-0123456789";
const RESOURCE = "https://vault.example.com/mcp";
const FIVE_MIB = 5 * 1024 * 1024;
const HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "mcp-protocol-version": "2025-06-18",
};

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "probe", version: "0" },
  },
});

describe("POST /mcp body bounds", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  function mcpApp(mode: "jwt" | "none"): HttpApp {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const auth = ServerConfigSchema.parse({
      vaults: [{ id: "v1", path: "/tmp/v1" }],
      auth: mode === "jwt" ? { mode, jwtSecret: JWT_SECRET, resource: RESOURCE } : { mode },
    }).auth;
    const handle = createHttpApp({
      name: "obsidian-tc",
      version: "t",
      registry: new ToolRegistry(),
      auth,
      db,
      vaultId: "v1",
      acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
      enableDnsRebindingProtection: false,
    });
    closers.push(() => handle.close());
    return handle;
  }

  async function bearer(): Promise<string> {
    const token = await new SignJWT({ sub: "agent", scopes: ["read:notes"] })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode(JWT_SECRET));
    return `Bearer ${token}`;
  }

  it("answers an authenticated 5 MiB POST with 413, a JSON-RPC error, and Connection: close", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: { pad: "x".repeat(FIVE_MIB) },
    });
    const { app } = mcpApp("jwt");
    const res = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          ...HEADERS,
          authorization: await bearer(),
          "content-length": String(Buffer.byteLength(body)),
        },
        body,
      }),
    );
    expect(res.status).toBe(413);
    expect(res.headers.get("connection")).toBe("close");
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "request body too large" },
      id: null,
    });
  });

  it("an authenticated initialize still succeeds and keeps the connection", async () => {
    const { app } = mcpApp("jwt");
    const res = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          ...HEADERS,
          authorization: await bearer(),
          "content-length": String(Buffer.byteLength(initialize)),
        },
        body: initialize,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("connection")).not.toBe("close");
  });

  it("malformed JSON answers 400 with JSON-RPC -32700", async () => {
    const { app } = mcpApp("none");
    const res = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { ...HEADERS, "content-length": "1" },
        body: "{",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32700, message: "parse error" },
      id: null,
    });
  });
});
