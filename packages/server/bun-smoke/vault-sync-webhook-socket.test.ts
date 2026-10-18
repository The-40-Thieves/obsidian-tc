// Connection lifetime for POST /hooks/vault-sync, measured on a real socket.
//
// In bun-smoke and not vitest because the defect exists only under Bun: Bun.serve keeps a socket
// open for its whole idle timeout (serveHono sets 120 s) when a response leaves the request body
// unread, so one unauthenticated 1-byte connection with a large Content-Length holds a socket for
// minutes. Node closes such a socket within half a second, so a vitest run passes against the
// unfixed code. The `Connection: close` header is pinned in vault-sync-webhook.test.ts; this file
// proves the header actually closes the socket.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { type ServerHandle, serveHono } from "../src/transports/serve";
import { mountVaultSyncWebhook } from "../src/transports/vault-sync-webhook";

const SECRET = "vault-sync-test-secret-0123456789abcdef";
const ONE_MIB = 1_048_576;
const CLOSE_WITHIN_MS = 1_000;

/** Writes raw request bytes on a real socket. Resolves with the status line and whether the server
 *  closed the connection within `withinMs`. The request body is never completed, so only the
 *  server's response decides whether the socket stays open. */
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

async function serveWebhook(options: {
  bodyDeadlineMs?: number;
}): Promise<{ server: ServerHandle; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "obtc-vault-sync-socket-"));
  const app = new Hono();
  mountVaultSyncWebhook(app, {
    secret: SECRET,
    triggerPath: join(root, "trigger"),
    ...(options.bodyDeadlineMs === undefined ? {} : { bodyDeadlineMs: options.bodyDeadlineMs }),
  });
  const server = await serveHono(app, { host: "127.0.0.1", port: 0 });
  return { server, root };
}

test("the real socket closes after a 401 with an unread body, within 1 s", async () => {
  const { server, root } = await serveWebhook({});
  try {
    const result = await exchange(
      server.port,
      `POST /hooks/vault-sync HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nContent-Length: ${ONE_MIB}\r\n\r\n{`,
      CLOSE_WITHIN_MS,
    );

    expect(result.statusLine).toContain(" 401 ");
    expect(result.closed).toBe(true);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real socket closes after a 408 on a stalled signed body, within 1 s", async () => {
  const { server, root } = await serveWebhook({ bodyDeadlineMs: 50 });
  try {
    const result = await exchange(
      server.port,
      `POST /hooks/vault-sync HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nContent-Length: ${ONE_MIB}\r\nX-Hub-Signature-256: sha256=${"0".repeat(64)}\r\n\r\n{`,
      CLOSE_WITHIN_MS,
    );

    expect(result.statusLine).toContain(" 408 ");
    expect(result.closed).toBe(true);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
