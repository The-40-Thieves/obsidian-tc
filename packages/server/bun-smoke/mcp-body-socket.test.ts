// The /mcp body bound measured on a real socket under Bun. A declared Content-Length over the SDK's
// 4 MiB limit is refused before the body is read, so the client sends only the head and one byte,
// and the socket must close on the 413 instead of waiting out Bun's idle timeout. Bun-only because
// the idle-timeout behaviour exists only under Bun.serve.
import { expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { FolderAcl } from "../src/acl";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { startHttp } from "../src/transports/http";

const FIVE_MIB = 5 * 1024 * 1024;
const CLOSE_WITHIN_MS = 1_000;

/** Writes a raw head on a real socket and resolves with the status line and whether it closed. */
function exchange(port: number, head: string): Promise<{ statusLine: string; closed: boolean }> {
  return new Promise((resolve) => {
    let received = "";
    const socket: Socket = connect(port, "127.0.0.1");
    const finish = (closed: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ statusLine: received.split("\r\n")[0] ?? "", closed });
    };
    const timer = setTimeout(() => finish(false), CLOSE_WITHIN_MS);
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

test("an oversize authenticated POST /mcp gets 413 on a real socket, and the socket closes", async () => {
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
    const result = await exchange(
      handle.port,
      `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${FIVE_MIB}\r\n\r\n{`,
    );
    expect(result.statusLine).toContain(" 413 ");
    expect(result.closed).toBe(true);
  } finally {
    await handle.close();
    db.close?.();
  }
});
