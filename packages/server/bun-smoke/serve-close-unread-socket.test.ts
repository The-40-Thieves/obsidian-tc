// Connection lifetime for a response that leaves the request body unread, measured on a real socket
// through `serveHono`. In bun-smoke and not vitest because the defect exists only under Bun:
// Bun.serve keeps a socket open for its whole idle timeout (120 s) after such a response, while Node
// closes it within half a second. The unit cases for `closeIfBodyUnread` are in
// test/serve-close-unread.test.ts; this file proves the header actually closes the socket, and that
// the runtime's second argument reaches the handler (Bun's `requestIP` needs the original Request).
import { expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { Hono } from "hono";
import { FolderAcl } from "../src/acl";
import { createClientIpResolver } from "../src/auth/client-ip";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { startHttp } from "../src/transports/http";
import {
  type ServerHandle,
  serveHono,
  UNREAD_BODY_DRAIN_MAX_BYTES,
  UNREAD_BODY_DRAIN_MS,
} from "../src/transports/serve";

const ONE_MIB = 1_048_576;
const CLOSE_WITHIN_MS = 1_000;
const MCP_HEADERS =
  "Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n";

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

/** Writes raw request bytes on a real socket. Resolves with the response head, whether the server
 *  closed the socket in time, and when the first response bytes and the close arrived, in ms from
 *  the start (`closedMs` stays Infinity without a close). The declared body is never completed
 *  unless `head` carries it, so only the server's response decides whether the socket stays open.
 *  `trickle` writes one more byte of the body every `everyMs` until the response starts. */
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
    const socket: Socket = connect(port, "127.0.0.1");
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
    const socket: Socket = connect(port, "127.0.0.1");
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

let server: ServerHandle | undefined;
const stop = async () => {
  await server?.close();
  server = undefined;
};

test("the real socket closes a GET with a declared body that is still arriving, within 1 s", async () => {
  server = await serveHono(app(), { host: "127.0.0.1", port: 0 });
  try {
    const result = await exchange(
      server.port,
      `GET /refuse HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${ONE_MIB}\r\n\r\n{`,
      CLOSE_WITHIN_MS,
    );
    expect(result.statusLine).toContain(" 401 ");
    expect(result.head.toLowerCase()).toContain("connection: close");
    expect(result.closed).toBe(true);
  } finally {
    await stop();
  }
});

test("the real socket closes after a 401 that left the body unread, with Connection: close in its headers, within 300 ms", async () => {
  server = await serveHono(app(), { host: "127.0.0.1", port: 0 });
  try {
    const result = await exchange(
      server.port,
      `POST /refuse HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${ONE_MIB}\r\n\r\n{`,
      CLOSE_WITHIN_MS,
    );
    expect(result.statusLine).toContain(" 401 ");
    expect(result.head.toLowerCase()).toContain("connection: close");
    expect(result.closed).toBe(true);
    expect(result.closedMs - result.statusMs).toBeLessThan(300);
  } finally {
    await stop();
  }
});

test("a trickled unread body gets its 401 within the drain deadline, and the socket closes within 1 s", async () => {
  server = await serveHono(app(), { host: "127.0.0.1", port: 0 });
  try {
    const result = await exchange(
      server.port,
      `POST /refuse HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${ONE_MIB}\r\n\r\n{`,
      CLOSE_WITHIN_MS,
      { everyMs: 50 },
    );
    expect(result.statusLine).toContain(" 401 ");
    expect(result.statusMs).toBeLessThan(UNREAD_BODY_DRAIN_MS + 200);
    expect(result.closed).toBe(true);
  } finally {
    await stop();
  }
});

test("an unread body over the byte cap, sent at once, closes the socket", async () => {
  server = await serveHono(app(), { host: "127.0.0.1", port: 0 });
  try {
    const body = "x".repeat(UNREAD_BODY_DRAIN_MAX_BYTES * 2);
    const result = await exchange(
      server.port,
      `POST /refuse HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
      CLOSE_WITHIN_MS,
    );
    expect(result.closed).toBe(true);
  } finally {
    await stop();
  }
});

test("a request whose body the handler read keeps the socket for a second request", async () => {
  server = await serveHono(app(), { host: "127.0.0.1", port: 0 });
  try {
    const result = await twoOnOneSocket(server.port, rawPost("/read"), "200");
    expect(result.responses).toBe(2);
    expect(result.closed).toBe(false);
  } finally {
    await stop();
  }
});

test("a request whose body the handler read through a clone keeps the socket for a second request", async () => {
  server = await serveHono(app(), { host: "127.0.0.1", port: 0 });
  try {
    const result = await twoOnOneSocket(server.port, rawPost("/clone"), "200");
    expect(result.responses).toBe(2);
    expect(result.closed).toBe(false);
  } finally {
    await stop();
  }
});

test("a fully sent body the handler never read keeps the socket for a second request (drain)", async () => {
  server = await serveHono(app(), { host: "127.0.0.1", port: 0 });
  try {
    const result = await twoOnOneSocket(server.port, rawPost("/refuse"), "401");
    expect(result.responses).toBe(2);
    expect(result.closed).toBe(false);
  } finally {
    await stop();
  }
});

test("a malformed JSON POST /mcp answers -32700 and the socket serves a second request", async () => {
  const db = await openDatabase(":memory:");
  provisionCacheDb(db);
  const handle = await startHttp({
    name: "obsidian-tc",
    version: "0.0.0-test",
    registry: new ToolRegistry(),
    auth: { mode: "none" } as never,
    db,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    host: "127.0.0.1",
    port: 0,
  });
  try {
    const result = await twoOnOneSocket(handle.port, rawPost("/mcp", MCP_HEADERS, "{"), "400");
    expect(result.responses).toBe(2);
    expect(result.closed).toBe(false);
  } finally {
    await handle.close();
    db.close?.();
  }
});

test("the client IP helper reads the address Hono was given through the wrapper", async () => {
  // The loopback peer is trusted, so the helper reads the forwarded client. Under Bun the address
  // comes from `requestIP` on the original Request, which only works if the wrapper passes both.
  const clientIp = createClientIpResolver({ trustedProxies: ["127.0.0.0/8", "::1"] });
  const ipApp = new Hono();
  ipApp.get("/ip", (c) => c.text(clientIp(c) ?? "none"));
  server = await serveHono(ipApp, { host: "127.0.0.1", port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/ip`, {
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    expect(await res.text()).toBe("203.0.113.7");
  } finally {
    await stop();
  }
});
