// Connection lifetime for a response that leaves the request body unread, measured on a real socket
// through `serveHono`. In bun-smoke and not vitest because the defect exists only under Bun:
// Bun.serve keeps a socket open for its whole idle timeout (120 s) after such a response, while Node
// closes it within half a second. The unit cases for `closeIfBodyUnread` are in
// test/serve-close-unread.test.ts; this file proves the header actually closes the socket.
import { expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { Hono } from "hono";
import { type ServerHandle, serveHono } from "../src/transports/serve";

const ONE_MIB = 1_048_576;
const CLOSE_WITHIN_MS = 1_000;

function app(): Hono {
  const app = new Hono();
  app.post("/refuse", (c) => c.text("nope", 401));
  app.post("/read", async (c) => {
    await c.req.text();
    return c.text("ok");
  });
  return app;
}

/** Writes raw request bytes on a real socket. Resolves with the status line and whether the server
 *  closed the connection within `withinMs`. The declared body is never completed, so only the
 *  server's response decides whether the socket stays open. */
function exchange(
  port: number,
  head: string,
  withinMs: number,
): Promise<{ statusLine: string; closed: boolean }> {
  return new Promise((resolve) => {
    let received = "";
    const socket: Socket = connect(port, "127.0.0.1");
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

/** Sends two requests on ONE socket and reports how many complete responses came back and whether
 *  the server closed the socket before the second one was answered. */
function twoOnOneSocket(port: number): Promise<{ responses: number; closed: boolean }> {
  const request = (path: string) =>
    `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 5\r\n\r\nhello`;
  return new Promise((resolve) => {
    let received = "";
    let sent = 1;
    const socket: Socket = connect(port, "127.0.0.1");
    const finish = (closed: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ responses: received.split("HTTP/1.1 200").length - 1, closed });
    };
    const timer = setTimeout(() => finish(false), 2_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(request("/read")));
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (sent === 1 && received.endsWith("ok")) {
        sent = 2;
        socket.write(request("/read"));
      } else if (sent === 2 && received.split("HTTP/1.1 200").length - 1 === 2) {
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

test("the real socket closes after a 401 that left the body unread, within 1 s", async () => {
  server = await serveHono(app(), { host: "127.0.0.1", port: 0 });
  try {
    const result = await exchange(
      server.port,
      `POST /refuse HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${ONE_MIB}\r\n\r\n{`,
      CLOSE_WITHIN_MS,
    );
    expect(result.statusLine).toContain(" 401 ");
    expect(result.closed).toBe(true);
  } finally {
    await stop();
  }
});

test("a request whose body the handler read keeps the socket for a second request", async () => {
  server = await serveHono(app(), { host: "127.0.0.1", port: 0 });
  try {
    const result = await twoOnOneSocket(server.port);
    expect(result.responses).toBe(2);
    expect(result.closed).toBe(false);
  } finally {
    await stop();
  }
});
