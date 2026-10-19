// /mcp reads the body itself before the MCP handler sees it. That read has to carry the MCP SDK's
// request-body limit: when the handler is handed `parsedBody`, the SDK never reads (or bounds) the
// body, so an oversized authenticated POST used to be parsed in full and accepted. The anonymous
// discovery candidate (auth.anonymousDiscovery "list", no credentials) is read under a tighter bound
// and deadline, because it is the one path a caller can reach without proving who they are.
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
const ANONYMOUS_DEADLINE_MS = 10_000;
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

const enc = new TextEncoder();

/** A body that arrives as the given chunks and then ends (no Content-Length: chunked). */
function chunkedBody(chunks: number, chunkBytes: number): ReadableStream<Uint8Array> {
  const piece = new Uint8Array(chunkBytes).fill(0x20);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < chunks; i++) controller.enqueue(piece);
      controller.close();
    },
  });
}

/** A body whose first byte arrives and whose remainder never does. */
function stalledBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode("{"));
    },
  });
}

function streamingPost(headers: Record<string, string>, body: ReadableStream<Uint8Array>) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit);
}

describe("POST /mcp body bounds", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });

  function mcpApp(mode: "jwt" | "none" | "list"): HttpApp {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const jwt = { mode: "jwt", jwtSecret: JWT_SECRET, resource: RESOURCE };
    const auth = ServerConfigSchema.parse({
      vaults: [{ id: "v1", path: "/tmp/v1" }],
      auth:
        mode === "none"
          ? { mode }
          : mode === "list"
            ? {
                ...jwt,
                authorizationServers: ["https://as.example.com"],
                anonymousDiscovery: "list",
              }
            : jwt,
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

  it("authenticated chunked 5 MiB POST (no Content-Length) gets 413", async () => {
    const { app } = mcpApp("jwt");
    const res = await app.fetch(
      streamingPost({ ...HEADERS, authorization: await bearer() }, chunkedBody(5, 1024 * 1024)),
    );
    expect(res.status).toBe(413);
    expect(res.headers.get("connection")).toBe("close");
  });

  it("authenticated POST that understates Content-Length (declares 10, sends 5 MiB) gets 413", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: { pad: "x".repeat(FIVE_MIB) },
    });
    const { app } = mcpApp("jwt");
    const res = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { ...HEADERS, authorization: await bearer(), "content-length": "10" },
        body,
      }),
    );
    expect(res.status).toBe(413);
    expect(res.headers.get("connection")).toBe("close");
  });

  it("authenticated POST with a malformed Content-Length still parses a small valid body", async () => {
    const { app } = mcpApp("jwt");
    const res = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { ...HEADERS, authorization: await bearer(), "content-length": "1, 1" },
        body: initialize,
      }),
    );
    expect(res.status).toBe(200);
  });

  it("regression guard (passes on the pre-fix code too): an authenticated initialize still succeeds and keeps the connection", async () => {
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

  it("regression guard (passes on the pre-fix code too): malformed JSON answers 400 with JSON-RPC -32700", async () => {
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

  it("anonymous discovery: an unparseable body keeps the 401 challenge, not -32700", async () => {
    const { app } = mcpApp("list");
    const res = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { ...HEADERS, "content-length": "1" },
        body: "{",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("anonymous discovery: a chunked body over 64 KiB gets 413 (no Content-Length)", async () => {
    const { app } = mcpApp("list");
    const res = await app.fetch(streamingPost(HEADERS, chunkedBody(3, 32 * 1024)));
    expect(res.status).toBe(413);
    expect(res.headers.get("connection")).toBe("close");
  });

  it(
    "anonymous discovery: a body that stalls gets 408 within the 10 s deadline (+200 ms)",
    async () => {
      const { app } = mcpApp("list");
      const started = Date.now();
      const res = await app.fetch(streamingPost(HEADERS, stalledBody()));
      const elapsed = Date.now() - started;
      expect(res.status).toBe(408);
      expect(res.headers.get("connection")).toBe("close");
      expect(elapsed).toBeGreaterThanOrEqual(ANONYMOUS_DEADLINE_MS - 50);
      expect(elapsed).toBeLessThan(ANONYMOUS_DEADLINE_MS + 200);
    },
    ANONYMOUS_DEADLINE_MS + 5_000,
  );
});
