// A response that leaves the request body unread must close the connection. Under Bun the socket
// otherwise stays open for the whole idle timeout (120 s in production) when the caller declared a
// body and never sent it. The rule lives in `closeIfBodyUnread`, wrapped around `app.fetch` in
// `serveHono`, the one place every listener goes through.
import { type AddressInfo, connect, createServer as createNetServer } from "node:net";
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import { createClientIpResolver } from "../src/auth/client-ip";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { createHttpApp, type HttpApp } from "../src/transports/http";
import {
  closeIfBodyUnread,
  type ServerHandle,
  serveHono,
  UNREAD_BODY_DRAIN_MAX_BYTES,
  UNREAD_BODY_DRAIN_MS,
} from "../src/transports/serve";
import { openMemoryDb } from "./helpers";

const JWT_SECRET = "test-only-secret-not-a-real-credential-0123456789";
const RESOURCE = "https://vault.example.com/mcp";
const ONE_MIB = 1_048_576;
const MCP_HEADERS =
  "Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n";

type Handler = (req: Request) => Response | Promise<Response>;

function post(path: string, init: { headers?: Record<string, string>; body?: string } = {}) {
  return new Request(`http://localhost${path}`, { method: "POST", ...init });
}

/** A POST whose body is a stream the test controls: `chunks` are sent, then the stream closes unless `open`. */
function streamed(
  path: string,
  chunks: Array<string | Uint8Array>,
  headers: Record<string, string>,
  open = false,
): Request {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      if (!open) controller.close();
    },
  });
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit);
}

describe("closeIfBodyUnread (unit)", () => {
  it("adds Connection: close when a declared body is still arriving and was never read", async () => {
    const fetch = closeIfBodyUnread((() => new Response("nope", { status: 401 })) as Handler);
    const res = await fetch(streamed("/x", ["hello"], { "content-length": "5" }, true));
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

  it("leaves Connection off when the handler read a clone of the body (the /mcp shape)", async () => {
    const fetch = closeIfBodyUnread((async (req: Request) => {
      await req.clone().text();
      return new Response("ok");
    }) as Handler);
    const res = await fetch(post("/x", { headers: { "content-length": "5" }, body: "hello" }));
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
    const res = await fetch(streamed("/x", ["hello"], { "content-length": "5" }, true));
    expect(res.headers.get("connection")).toBe("keep-alive");
  });

  it("re-wraps an immutable-headers Response and keeps its status and headers", async () => {
    const fetch = closeIfBodyUnread((() =>
      Response.redirect("https://example.com/next", 302)) as Handler);
    const res = await fetch(streamed("/x", ["hello"], { "content-length": "5" }, true));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/next");
    expect(res.headers.get("connection")).toBe("close");
  });

  it("adds Connection: close for a Transfer-Encoding: chunked body that was never read", async () => {
    const fetch = closeIfBodyUnread((() => new Response("nope", { status: 401 })) as Handler);
    const res = await fetch(streamed("/x", ["hello"], { "transfer-encoding": "chunked" }, true));
    expect(res.headers.get("connection")).toBe("close");
  });

  it("drains a small body that was fully sent but not read, and keeps the connection", async () => {
    const fetch = closeIfBodyUnread((() => new Response("nope", { status: 401 })) as Handler);
    const res = await fetch(streamed("/x", ["hello"], { "content-length": "5" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("connection")).toBeNull();
  });

  it("closes a body still trickling when the drain deadline passes, and answers within the bound", async () => {
    const fetch = closeIfBodyUnread((() => new Response("nope", { status: 401 })) as Handler);
    const started = performance.now();
    const res = await fetch(streamed("/x", ["{"], { "content-length": "1000000" }, true));
    expect(res.headers.get("connection")).toBe("close");
    expect(performance.now() - started).toBeLessThan(UNREAD_BODY_DRAIN_MS + 200);
  });

  it("closes a body over the byte cap", async () => {
    const fetch = closeIfBodyUnread((() => new Response("nope", { status: 401 })) as Handler);
    const big = new Uint8Array(UNREAD_BODY_DRAIN_MAX_BYTES + 1);
    const res = await fetch(streamed("/x", [big], { "content-length": String(big.byteLength) }));
    expect(res.headers.get("connection")).toBe("close");
  });

  it("closes when the unread body errors, without an unhandled rejection", async () => {
    const fetch = closeIfBodyUnread((() => new Response("nope", { status: 401 })) as Handler);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("client went away"));
      },
    });
    const req = new Request("http://localhost/x", {
      method: "POST",
      headers: { "content-length": "5" },
      body,
      duplex: "half",
    } as RequestInit);
    const res = await fetch(req);
    expect(res.headers.get("connection")).toBe("close");
  });

  it("streams the response body through unbuffered", async () => {
    // An upstream fetch Response has immutable headers, so the wrapper re-wraps it. The upstream
    // writes a raw chunked response with no Connection header: node:http adds one, and the wrapper
    // leaves a response that has one alone, so it would never reach the re-wrap. The upstream holds
    // its second chunk until the client has read the first, so a re-wrap that buffered would hang
    // the read below.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const upstream = createNetServer((socket) => {
      socket.once("data", () => {
        socket.write(
          "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n" +
            "d\r\ndata: first\n\n\r\n",
        );
        void held.then(() => socket.end("e\r\ndata: second\n\n\r\n0\r\n\r\n"));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const { port } = upstream.address() as AddressInfo;
    try {
      const wrapped = closeIfBodyUnread((() =>
        globalThis.fetch(`http://127.0.0.1:${port}/`)) as Handler);
      const res = await wrapped(streamed("/x", ["hello"], { "content-length": "5" }, true));
      // The open request body makes the wrapper set Connection: close on the re-wrapped copy.
      expect(res.headers.get("connection")).toBe("close");
      const reader = res.body?.getReader();
      if (!reader) throw new Error("the re-wrapped response has no body");
      const decoder = new TextDecoder();
      const first = await reader.read();
      expect(decoder.decode(first.value)).toBe("data: first\n\n");
      release();
      let rest = "";
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        rest += decoder.decode(next.value);
      }
      expect(rest).toBe("data: second\n\n");
    } finally {
      release();
      upstream.close();
    }
  });

  it("closes a GET with a declared body that is still arriving (req.body is null)", async () => {
    const fetch = closeIfBodyUnread((() => new Response("nope", { status: 401 })) as Handler);
    const req = new Request("http://localhost/x", {
      headers: { "content-length": String(ONE_MIB) },
    });
    expect(req.body).toBeNull();
    const res = await fetch(req);
    expect(res.headers.get("connection")).toBe("close");
  });

  it("a locked body the handler never reads gets Connection: close, not a 500", async () => {
    const fetch = closeIfBodyUnread(((req: Request) => {
      req.body?.getReader();
      return new Response("nope", { status: 401 });
    }) as Handler);
    const res = await fetch(streamed("/x", ["hello"], { "content-length": "5" }, true));
    expect(res.status).toBe(401);
    expect(res.headers.get("connection")).toBe("close");
  });

  it("keeps the connection for a 1.5 MiB body the handler read through a clone", async () => {
    const fetch = closeIfBodyUnread((async (req: Request) => {
      await req.clone().text();
      return new Response("ok");
    }) as Handler);
    const big = new Uint8Array(1.5 * ONE_MIB);
    const res = await fetch(streamed("/x", [big], { "content-length": String(big.byteLength) }));
    expect(res.headers.get("connection")).toBeNull();
  });

  it("closes a declared length over the cap before the drain deadline", async () => {
    const fetch = closeIfBodyUnread((() => new Response("nope", { status: 401 })) as Handler);
    const started = performance.now();
    const res = await fetch(streamed("/x", ["{"], { "content-length": "5000000" }, true));
    expect(res.headers.get("connection")).toBe("close");
    expect(performance.now() - started).toBeLessThan(150);
  });

  it.each(["100, 100", "abc", "-1"])(
    "a malformed Content-Length (%j) counts as a declared body",
    async (value) => {
      const fetch = closeIfBodyUnread((() => new Response("nope", { status: 401 })) as Handler);
      const res = await fetch(streamed("/x", ["hello"], { "content-length": value }, true));
      expect(res.headers.get("connection")).toBe("close");
    },
  );

  it("does not wait for cancel() on an unread body whose cancel never settles", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("{"));
      },
      cancel() {
        return new Promise<void>(() => {});
      },
    });
    const fetch = closeIfBodyUnread((() => new Response("nope", { status: 401 })) as Handler);
    const started = performance.now();
    const res = await fetch(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "content-length": String(ONE_MIB) },
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(res.headers.get("connection")).toBe("close");
    expect(performance.now() - started).toBeLessThan(UNREAD_BODY_DRAIN_MS + 100);
  });

  it("cancels the original body when the handler set Connection and the body is unread", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetch = closeIfBodyUnread(
      (() =>
        new Response("stream", {
          status: 200,
          headers: { connection: "keep-alive" },
        })) as Handler,
    );
    const res = await fetch(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "content-length": "5" },
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(res.headers.get("connection")).toBe("keep-alive");
    await new Promise((resolve) => setImmediate(resolve));
    expect(cancelled).toBe(true);
  });

  it("returns a 101 response unchanged when its headers are immutable", async () => {
    const original = Response.redirect("https://example.com/next", 302);
    Object.defineProperty(original, "status", { value: 101 });
    const fetch = closeIfBodyUnread((() => original) as Handler);
    const res = await fetch(streamed("/x", ["hello"], { "content-length": "5" }, true));
    expect(res).toBe(original);
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
      streamed(
        "/mcp",
        ["{"],
        {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": String(ONE_MIB),
        },
        true,
      ),
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

  it("a malformed JSON POST /mcp answers -32700 and the socket serves a second request", async () => {
    const server = await serveHono(mcpApp("none").app, { host: "127.0.0.1", port: 0 });
    closers.push(() => server.close());
    const result = await twoOnOneSocket(server.port, rawPost("/mcp", MCP_HEADERS, "{"), "400");
    expect(result.responses).toBe(2);
    expect(result.closed).toBe(false);
  });
});

/** Writes raw request bytes on a real socket. Resolves with the response head, whether the server
 *  closed the socket in time, and when the first response bytes and the close arrived, in ms from
 *  the start (`closedMs` stays Infinity without a close). `trickle` writes one more byte of the body
 *  every `everyMs` until the response starts. */
function exchange(
  port: number,
  head: string,
  withinMs: number,
  trickle?: { everyMs: number },
): Promise<{
  statusLine: string;
  head: string;
  closed: boolean;
  statusMs: number;
  closedMs: number;
}> {
  return new Promise((resolve) => {
    let received = "";
    let statusMs = -1;
    let closedMs = Number.POSITIVE_INFINITY;
    let drip: ReturnType<typeof setInterval> | undefined;
    const started = performance.now();
    const socket = connect(port, "127.0.0.1");
    const finish = (closed: boolean) => {
      clearTimeout(timer);
      clearInterval(drip);
      if (closed) closedMs = performance.now() - started;
      socket.destroy();
      resolve({
        statusLine: received.split("\r\n")[0] ?? "",
        head: received.split("\r\n\r\n")[0] ?? "",
        closed,
        statusMs,
        closedMs,
      });
    };
    const timer = setTimeout(() => finish(false), withinMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(head);
      if (trickle) drip = setInterval(() => socket.write("{"), trickle.everyMs);
    });
    socket.on("data", (chunk: string) => {
      if (statusMs < 0) {
        statusMs = performance.now() - started;
        clearInterval(drip);
      }
      received += chunk;
    });
    socket.on("end", () => finish(true));
    socket.on("close", () => finish(true));
    socket.on("error", () => finish(true));
  });
}

/** A raw POST whose Content-Length matches `body`, for writing bytes on a real socket. */
function rawPost(path: string, headers = "", body = "hello"): string {
  return `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n${headers}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

/** Two requests on ONE socket: resolves with how many responses with `status` came back, and whether
 *  the server closed the socket before the second one was answered. */
function twoOnOneSocket(
  port: number,
  request: string,
  status: string,
): Promise<{ responses: number; closed: boolean }> {
  return new Promise((resolve) => {
    let received = "";
    let sent = 1;
    const socket = connect(port, "127.0.0.1");
    const count = () => received.split(`HTTP/1.1 ${status}`).length - 1;
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
      if (sent === 1 && count() === 1) {
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
    app.get("/refuse", (c) => c.text("nope", 401));
    app.post("/read", async (c) => {
      await c.req.text();
      return c.text("ok");
    });
    app.post("/clone", async (c) => {
      await c.req.raw.clone().text();
      return c.text("ok");
    });
    return app;
  }

  it("closes a GET with a declared body that is still arriving, within 1 s", async () => {
    server = await serveHono(app(), { host: "127.0.0.1", port: 0 });
    const result = await exchange(
      server.port,
      `GET /refuse HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${ONE_MIB}\r\n\r\n{`,
      1_000,
    );
    expect(result.statusLine).toContain(" 401 ");
    expect(result.head.toLowerCase()).toContain("connection: close");
    expect(result.closed).toBe(true);
  });

  it("closes after a 401 that left the body unread, with Connection: close in its headers, within 300 ms", async () => {
    server = await serveHono(app(), { host: "127.0.0.1", port: 0 });
    const result = await exchange(
      server.port,
      `POST /refuse HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${ONE_MIB}\r\n\r\n{`,
      1_000,
    );
    expect(result.statusLine).toContain(" 401 ");
    expect(result.head.toLowerCase()).toContain("connection: close");
    expect(result.closed).toBe(true);
    expect(result.closedMs - result.statusMs).toBeLessThan(300);
  });

  it("a trickled unread body gets its 401 within the drain deadline, and the socket closes within 1 s", async () => {
    server = await serveHono(app(), { host: "127.0.0.1", port: 0 });
    const result = await exchange(
      server.port,
      `POST /refuse HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${ONE_MIB}\r\n\r\n{`,
      1_000,
      { everyMs: 50 },
    );
    expect(result.statusLine).toContain(" 401 ");
    expect(result.statusMs).toBeLessThan(UNREAD_BODY_DRAIN_MS + 200);
    expect(result.closed).toBe(true);
  });

  it("an unread body over the byte cap, sent at once, closes the socket", async () => {
    server = await serveHono(app(), { host: "127.0.0.1", port: 0 });
    const body = "x".repeat(UNREAD_BODY_DRAIN_MAX_BYTES * 2);
    const result = await exchange(
      server.port,
      `POST /refuse HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
      1_000,
    );
    expect(result.closed).toBe(true);
  });

  it("a request whose body the handler read keeps the socket for a second request", async () => {
    server = await serveHono(app(), { host: "127.0.0.1", port: 0 });
    const result = await twoOnOneSocket(server.port, rawPost("/read"), "200");
    expect(result.responses).toBe(2);
    expect(result.closed).toBe(false);
  });

  it("a request whose body the handler read through a clone keeps the socket for a second request", async () => {
    server = await serveHono(app(), { host: "127.0.0.1", port: 0 });
    const result = await twoOnOneSocket(server.port, rawPost("/clone"), "200");
    expect(result.responses).toBe(2);
    expect(result.closed).toBe(false);
  });

  it("a fully sent body the handler never read keeps the socket for a second request", async () => {
    server = await serveHono(app(), { host: "127.0.0.1", port: 0 });
    const result = await twoOnOneSocket(server.port, rawPost("/refuse"), "401");
    expect(result.responses).toBe(2);
    expect(result.closed).toBe(false);
  });

  it("the client IP helper reads the address Hono was given through the wrapper", async () => {
    // The loopback peer is trusted, so the helper reads the forwarded client. Without the env Hono
    // passes the wrapper, the helper cannot see the peer and answers "none".
    const clientIp = createClientIpResolver({ trustedProxies: ["127.0.0.0/8", "::1"] });
    const ipApp = new Hono();
    ipApp.get("/ip", (c) => c.text(clientIp(c) ?? "none"));
    server = await serveHono(ipApp, { host: "127.0.0.1", port: 0 });
    const res = await fetch(`http://127.0.0.1:${server.port}/ip`, {
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    expect(await res.text()).toBe("203.0.113.7");
  });
});
