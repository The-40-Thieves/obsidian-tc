// Every provider client armed its timeout for the response HEADERS and cleared it before reading the
// body. An endpoint that answers `200` and then stalls mid-body kept the request, its promise and its
// socket alive past `timeoutMs` forever. The reviewer's repro: a server sending 200 headers and an
// incomplete JSON body, `timeoutMs: 50` -- the promise was still pending after 300 ms.
//
// Each client below is driven against a REAL local server that stalls mid-body, through both the
// shared policy fetch (the socket this repo opens itself) and the runtime's global fetch (the https
// leg), and must reject within the timeout with the socket closed, not merely abandoned.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBridgeClient } from "../src/bridge/transport";
import { postJson } from "../src/embeddings/http";
import { createGatewayClient } from "../src/gateway/client";
import { providerFetch } from "../src/gateway/provider-fetch";
import { ProviderBodyTooLargeError, readBodyText } from "../src/gateway/read-body";
import { createTypesafeClient } from "../src/gateway/typesafe";
import { teiModelClient } from "../src/model/tei";

let server: http.Server;
let port: number;
let socketClosed: Promise<void>;
let closeSocket: () => void;

beforeEach(async () => {
  socketClosed = new Promise<void>((r) => {
    closeSocket = r;
  });
  server = http.createServer((req, res) => {
    req.resume();
    if (req.url === "/warm") {
      res.end("{}");
      return;
    }
    req.socket.once("close", () => closeSocket());
    res.writeHead(200, { "content-type": "application/json", "content-length": "100000" });
    res.write('{"choices":[{"message":{"content":"par');
    // ...and never finishes.
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  // Warm both transports first. A cold first request can take longer than the 50 ms timeout just to
  // deliver its HEADERS, which would "pass" the stall test for the wrong reason (the old code also
  // rejects when the timer fires before the headers arrive).
  for (const f of [providerFetch, globalThis.fetch]) {
    await (await f(`http://127.0.0.1:${port}/warm`)).text();
  }
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const FETCHES: [string, typeof fetch][] = [
  ["policy fetch (providerFetch)", providerFetch],
  [
    "global fetch (the https leg)",
    ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a)) as typeof fetch,
  ],
];

/** The client call must reject inside one second (the timeout is 50 ms) and the server must see the
 *  socket go away. `bestEffort` is for a lookup that swallows its own failure: it must still SETTLE
 *  inside the bound, resolving with its fallback. */
async function expectBoundedRejection(
  call: () => Promise<unknown>,
  bestEffort = false,
): Promise<void> {
  const t0 = Date.now();
  const outcome = await Promise.race([
    call().then(
      () => "resolved",
      () => "rejected",
    ),
    new Promise<string>((r) => setTimeout(() => r("still pending"), 1_000)),
  ]);
  expect(bestEffort ? ["rejected", "resolved"] : ["rejected"]).toContain(outcome);
  expect(Date.now() - t0).toBeLessThan(1_000);
  await Promise.race([
    socketClosed,
    new Promise<void>((_, rej) => setTimeout(() => rej(new Error("socket left open")), 1_000)),
  ]);
}

describe.each(FETCHES)("a mid-body stall is bounded by the timeout: %s", (_name, fetchFn) => {
  it("gateway client (chat completion)", async () => {
    const client = createGatewayClient({
      baseUrl: `http://127.0.0.1:${port}`,
      fetchFn,
      timeoutMs: 50,
      maxAttempts: 1,
    });
    await expectBoundedRejection(() =>
      client.judge({ messages: [{ role: "user", content: "x" }], sourcePaths: [] }),
    );
  });

  it("gateway client (rerank)", async () => {
    const client = createGatewayClient({
      baseUrl: `http://127.0.0.1:${port}`,
      fetchFn,
      timeoutMs: 50,
      maxAttempts: 1,
    });
    await expectBoundedRejection(() =>
      client.rerank({ query: "q", documents: ["a"], sourcePaths: [] }),
    );
  });

  it("typesafe client", async () => {
    const client = createTypesafeClient({
      baseUrl: `http://127.0.0.1:${port}`,
      fetchFn,
      timeoutMs: 50,
      maxAttempts: 1,
    });
    await expectBoundedRejection(() =>
      client.noul({
        state: {},
        model: "m",
        instructions: "i",
        criteria: { true: "t", false: "f" },
      }),
    );
  });

  it("embeddings / reranker postJson (also TEI and the model tier)", async () => {
    await expectBoundedRejection(() =>
      postJson({
        url: `http://127.0.0.1:${port}/v1/embeddings`,
        body: {},
        fetchFn,
        timeoutMs: 50,
        provider: "test",
        credentialSlot: "none",
      }),
    );
  });

  it("bridge transport", async () => {
    const bridge = createBridgeClient({
      baseUrl: `http://127.0.0.1:${port}`,
      fetchFn,
      timeoutMs: 50,
    });
    await expectBoundedRejection(() => bridge.request({ method: "GET", path: "/x" }));
  });

  it("bridge transport (native passthrough)", async () => {
    const bridge = createBridgeClient({
      baseUrl: `http://127.0.0.1:${port}`,
      fetchFn,
      timeoutMs: 50,
    });
    await expectBoundedRejection(() => bridge.requestNative({ method: "GET", path: "/commands/" }));
  });

  it("TEI /info provenance lookup", async () => {
    const tei = teiModelClient({
      baseUrl: `http://127.0.0.1:${port}`,
      fetchFn,
      timeoutMs: 50,
      dimensions: 4,
    });
    await expectBoundedRejection(() => tei.embed({ texts: [] }), true);
  });
});

describe("the body is size-capped", () => {
  it("a body over the limit is refused and the stream cancelled", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(64));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readBodyText(new Response(body), 1_000)).rejects.toBeInstanceOf(
      ProviderBodyTooLargeError,
    );
    expect(cancelled).toBe(true);
  });

  it("a declared content-length over the limit is refused before reading", async () => {
    const res = new Response("x".repeat(100), { headers: { "content-length": "100" } });
    await expect(readBodyText(res, 10)).rejects.toBeInstanceOf(ProviderBodyTooLargeError);
  });

  it("a body within the limit is returned whole", async () => {
    await expect(readBodyText(new Response('{"a":"é"}'), 1_000)).resolves.toBe('{"a":"é"}');
  });
});
