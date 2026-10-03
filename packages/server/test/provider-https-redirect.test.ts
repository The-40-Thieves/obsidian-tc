// An https:// provider request goes to the ordinary fetch, whose default redirect handling replays a
// 307/308 POST body (the bearer key and vault text) to whatever Location the endpoint names. The
// plain-http leg refuses redirects; the https leg must too. The reviewer's repro: an https endpoint
// answering `307 Location: http://127.0.0.1:<sink>/leak` must leave the sink with zero requests.
//
// No TLS server is needed: the https URL is handed to a base fetch that forwards the SAME init to a
// plain local origin through the runtime's real fetch, so the redirect behaviour under test is the
// runtime's own, driven by whatever `redirect` option the policy fetch passes down.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGatewayClient } from "../src/gateway/client";
import { createPlainHttpPolicyFetch, PlainHttpRefusedError } from "../src/gateway/plain-http";
import { providerFetch } from "../src/gateway/provider-fetch";

const realFetch = globalThis.fetch;
const SECRET_BODY = JSON.stringify({ text: "vault note text", key: "sk-secret" });

let origin: http.Server;
let sink: http.Server;
let originPort: number;
let sinkPort: number;
let sinkHits: { method: string | undefined; url: string | undefined; body: string }[];
let originStatus: number;
let originLocation: string;

const listen = async (s: http.Server): Promise<number> => {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as AddressInfo).port;
};

beforeEach(async () => {
  sinkHits = [];
  originStatus = 307;
  sink = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      sinkHits.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  sinkPort = await listen(sink);
  originLocation = `http://127.0.0.1:${sinkPort}/leak`;
  origin = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(originStatus, { location: originLocation });
      res.end();
    });
  });
  originPort = await listen(origin);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all([origin, sink].map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** The https endpoint of the repro, served by the local origin. Forwards `init` untouched. */
const httpsAsLocalOrigin: typeof fetch = (input, init) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  expect(u.protocol).toBe("https:");
  return realFetch(`http://127.0.0.1:${originPort}${u.pathname}`, init);
};

describe("an https endpoint that answers with a redirect", () => {
  it.each([301, 302, 303, 307, 308])(
    "%i: is refused with a clear error and the Location target receives nothing",
    async (status) => {
      originStatus = status;
      const f = createPlainHttpPolicyFetch({
        plainHttpHosts: [],
        baseFetch: httpsAsLocalOrigin,
      });
      const err = await f("https://provider.example/v1/embeddings", {
        method: "POST",
        headers: { authorization: "Bearer sk-secret", "content-type": "application/json" },
        body: SECRET_BODY,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PlainHttpRefusedError);
      expect((err as Error).message).toMatch(/provider\.example/);
      expect((err as Error).message).toMatch(/redirect/i);
      expect((err as Error).message).not.toContain("sk-secret");
      expect((err as Error).message).not.toContain("/leak");
      expect(sinkHits).toEqual([]);
    },
  );

  it("a caller that asks for redirect: follow is not honoured", async () => {
    const f = createPlainHttpPolicyFetch({ plainHttpHosts: [], baseFetch: httpsAsLocalOrigin });
    await expect(
      f("https://provider.example/v1/x", { method: "POST", body: SECRET_BODY, redirect: "follow" }),
    ).rejects.toBeInstanceOf(PlainHttpRefusedError);
    expect(sinkHits).toEqual([]);
  });

  it("a 3xx without a Location (304) is an ordinary response, not a refusal", async () => {
    const f = createPlainHttpPolicyFetch({
      plainHttpHosts: [],
      baseFetch: async () => new Response(null, { status: 304 }),
    });
    expect((await f("https://provider.example/x", { method: "GET" })).status).toBe(304);
  });

  it("an ordinary 200 passes through untouched", async () => {
    const f = createPlainHttpPolicyFetch({
      plainHttpHosts: [],
      baseFetch: async () => new Response('{"ok":true}', { status: 200 }),
    });
    expect(await (await f("https://provider.example/x", { method: "POST", body: "{}" })).json()).toEqual({
      ok: true,
    });
  });

  it("the shared providerFetch (every provider client's default transport) refuses it too", async () => {
    vi.stubGlobal("fetch", httpsAsLocalOrigin);
    await expect(
      providerFetch("https://provider.example/v1/embeddings", { method: "POST", body: SECRET_BODY }),
    ).rejects.toBeInstanceOf(PlainHttpRefusedError);
    expect(sinkHits).toEqual([]);
  });

  it("the gateway client surfaces the refusal without retrying and without reaching the sink", async () => {
    vi.stubGlobal("fetch", httpsAsLocalOrigin);
    let sleeps = 0;
    const client = createGatewayClient({
      baseUrl: "https://gateway.example",
      token: "sk-secret",
      sleepFn: async () => {
        sleeps++;
      },
    });
    const err = await client
      .extract({ messages: [{ role: "user", content: "vault note text" }], sourcePaths: [] })
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/refused.*redirect/i);
    expect(sleeps).toBe(0);
    expect(sinkHits).toEqual([]);
  });
});
