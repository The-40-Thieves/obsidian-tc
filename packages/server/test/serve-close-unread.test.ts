// A response that leaves the request body unread must close the connection. Under Bun the socket
// otherwise stays open for the whole idle timeout (120 s in production) when the caller declared a
// body and never sent it. The rule lives in `closeIfBodyUnread`, wrapped around `app.fetch` in
// `serveHono`, the one place every listener goes through.
import { connect } from "node:net";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { createHttpApp, type HttpApp } from "../src/transports/http";
import { closeIfBodyUnread, type ServerHandle, serveHono } from "../src/transports/serve";
import { openMemoryDb } from "./helpers";

const JWT_SECRET = "test-only-secret-not-a-real-credential-0123456789";
const RESOURCE = "https://vault.example.com/mcp";
const ONE_MIB = 1_048_576;

type Handler = (req: Request) => Response | Promise<Response>;

function post(path: string, init: { headers?: Record<string, string>; body?: string } = {}) {
  return new Request(`http://localhost${path}`, { method: "POST", ...init });
}

describe("closeIfBodyUnread (unit)", () => {
  it("adds Connection: close when a declared body was never read", async () => {
    const fetch = closeIfBodyUnread((() => new Response("nope", { status: 401 })) as Handler);
    const res = await fetch(post("/x", { headers: { "content-length": "5" }, body: "hello" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("connection")).toBe("close");
  });

  it("leaves Connection off when the handler read the body", async () => {
    const fetch = closeIfBodyUnread((async (req: Request) => {
      await req.text();
      return new Response("ok");
    }) as Handler);
    const res = await fetch(post("/x", { headers: { "content-length": "5" }, body: "hello" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("connection")).toBeNull();
  });

  it("leaves Connection off for a GET with no body", async () => {
    const fetch = closeIfBodyUnread((() => new Response("nope", { status: 401 })) as Handler);
    const res = await fetch(new Request("http://localhost/x"));
    expect(res.headers.get("connection")).toBeNull();
  });

  it("leaves Connection off for Content-Length: 0", async () => {
    const fetch = closeIfBodyUnread((() => new Response("nope", { status: 401 })) as Handler);
    const res = await fetch(post("/x", { headers: { "content-length": "0" }, body: "" }));
    expect(res.headers.get("connection")).toBeNull();
  });

  it("does not overwrite a Connection header the handler already set", async () => {
    const fetch = closeIfBodyUnread(
      (() =>
        new Response("nope", { status: 401, headers: { connection: "keep-alive" } })) as Handler,
    );
    const res = await fetch(post("/x", { headers: { "content-length": "5" }, body: "hello" }));
    expect(res.headers.get("connection")).toBe("keep-alive");
  });

  it("re-wraps an immutable-headers Response and keeps its status and headers", async () => {
    const fetch = closeIfBodyUnread((() =>
      Response.redirect("https://example.com/next", 302)) as Handler);
    const res = await fetch(post("/x", { headers: { "content-length": "5" }, body: "hello" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/next");
    expect(res.headers.get("connection")).toBe("close");
  });

  it("adds Connection: close for a Transfer-Encoding: chunked body that was never read", async () => {
    const fetch = closeIfBodyUnread((() => new Response("nope", { status: 401 })) as Handler);
    const res = await fetch(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "transfer-encoding": "chunked" },
        body: "hello",
        duplex: "half",
      } as RequestInit),
    );
    expect(res.headers.get("connection")).toBe("close");
  });

  it("streams the response body through unbuffered", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: first\n\n"));
        controller.close();
      },
    });
    const fetch = closeIfBodyUnread(
      (() =>
        new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        })) as Handler,
    );
    const res = await fetch(new Request("http://localhost/x"));
    expect(res.body).not.toBeNull();
    expect(await res.text()).toBe("data: first\n\n");
  });
});

describe("/mcp through the wrapper", () => {
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

  it("an unauthenticated POST /mcp with a declared body closes the connection", async () => {
    const fetch = closeIfBodyUnread(mcpApp("jwt").app.fetch as Handler);
    const res = await fetch(
      post("/mcp", {
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": String(ONE_MIB),
        },
        body: "{",
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("connection")).toBe("close");
  });

  it("an authenticated POST /mcp initialize, whose body the handler reads, keeps the connection", async () => {
    const token = await new SignJWT({ sub: "agent", scopes: ["read:notes"] })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode(JWT_SECRET));
    const fetch = closeIfBodyUnread(mcpApp("jwt").app.fetch as Handler);
    const res = await fetch(
      post("/mcp", {
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
          authorization: `Bearer ${token}`,
          "content-length": String(Buffer.byteLength(initialize)),
        },
        body: initialize,
      }),
    );
    expect(res.status).toBe(200);
    // The SSE response sets its own keep-alive, which the wrapper leaves alone.
    expect(res.headers.get("connection")).not.toBe("close");
  });
});

/** Writes raw request bytes on a real socket and reports whether the server closed it in time. */
function exchange(
  port: number,
  head: string,
  withinMs: number,
): Promise<{ statusLine: string; closed: boolean }> {
  return new Promise((resolve) => {
    let received = "";
    const socket = connect(port, "127.0.0.1");
    const finish = (closed: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ statusLine: received.split("\r\n")[0] ?? "", closed });
    };
    const timer = setTimeout(() => finish(false), withinMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(head));
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    socket.on("end", () => finish(true));
    socket.on("close", () => finish(true));
    socket.on("error", () => finish(true));
  });
}

/** Two requests on ONE socket: resolves with how many 200s came back, and whether the server closed
 *  the socket before the second one was answered. */
function twoOnOneSocket(port: number): Promise<{ responses: number; closed: boolean }> {
  const request = `POST /read HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 5\r\n\r\nhello`;
  return new Promise((resolve) => {
    let received = "";
    let sent = 1;
    const socket = connect(port, "127.0.0.1");
    const count = () => received.split("HTTP/1.1 200").length - 1;
    const finish = (closed: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ responses: count(), closed });
    };
    const timer = setTimeout(() => finish(false), 2_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (sent === 1 && received.endsWith("ok")) {
        sent = 2;
        socket.write(request);
      } else if (sent === 2 && count() === 2) {
        finish(false);
      }
    });
    socket.on("end", () => finish(true));
    socket.on("close", () => finish(true));
    socket.on("error", () => finish(true));
  });
}

describe("serveHono on a real Node socket", () => {
  let server: ServerHandle | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  function app(): Hono {
    const app = new Hono();
    app.post("/refuse", (c) => c.text("nope", 401));
    app.post("/read", async (c) => {
      await c.req.text();
      return c.text("ok");
    });
    return app;
  }

  it("closes after a 401 that left the body unread, within 1 s", async () => {
    server = await serveHono(app(), { host: "127.0.0.1", port: 0 });
    const result = await exchange(
      server.port,
      `POST /refuse HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${ONE_MIB}\r\n\r\n{`,
      1_000,
    );
    expect(result.statusLine).toContain(" 401 ");
    expect(result.closed).toBe(true);
  });

  it("a request whose body the handler read keeps the socket for a second request", async () => {
    server = await serveHono(app(), { host: "127.0.0.1", port: 0 });
    const result = await twoOnOneSocket(server.port);
    expect(result.responses).toBe(2);
    expect(result.closed).toBe(false);
  });
});
