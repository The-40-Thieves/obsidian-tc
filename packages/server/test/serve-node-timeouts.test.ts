// The Node branch of serveHono passes server timeouts to @hono/node-server. Under Node,
// `requestTimeout` is checked only on each `connectionsCheckingInterval` tick (30 s by default),
// and the default request timeout is 300 s. A socket that sends headers and a partial body and
// then stops was held for minutes. These cases pin the resolved values and the wire behaviour.
import { connect } from "node:net";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { BUN_IDLE_TIMEOUT_SECONDS, NODE_SERVER_OPTIONS, serveHono } from "../src/transports/serve";
import { stallTimeout } from "./stall-timeouts";

describe("Node server options", () => {
  it("request timeout matches the Bun idle ceiling, with a headers timeout and a 1 s checking interval", () => {
    expect(NODE_SERVER_OPTIONS.requestTimeout).toBe(BUN_IDLE_TIMEOUT_SECONDS * 1000);
    expect(NODE_SERVER_OPTIONS.headersTimeout).toBe(60_000);
    expect(NODE_SERVER_OPTIONS.connectionsCheckingInterval).toBe(1_000);
  });

  it(
    "a socket that stalls mid-body gets 408 from Node within requestTimeout + the checking interval",
    async () => {
      const app = new Hono();
      app.post("/hang", async (c) => c.text(await c.req.text()));
      const handle = await serveHono(app, {
        host: "127.0.0.1",
        port: 0,
        nodeServerOptions: {
          requestTimeout: 3_000,
          headersTimeout: 2_000,
          connectionsCheckingInterval: 500,
        },
      });
      try {
        const reply = await new Promise<string>((resolve, reject) => {
          const socket = connect(handle.port, "127.0.0.1");
          let data = "";
          socket.setEncoding("utf8");
          socket.on("data", (chunk: string) => {
            data += chunk;
          });
          socket.on("error", reject);
          socket.on("close", () => resolve(data));
          socket.write(
            "POST /hang HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\nContent-Length: 100\r\n\r\npartial",
          );
        });
        expect(reply.startsWith("HTTP/1.1 408")).toBe(true);
      } finally {
        await handle.close();
      }
    },
    stallTimeout(15_000),
  );
});
