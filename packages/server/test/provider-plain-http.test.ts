// The plain-http policy for EVERY outbound provider client (gateway, embeddings, reranker, model
// tier, Obsidian bridge, plur), not only the TypeSafe judge: each one, built with no fetchFn, sends
// through gateway/provider-fetch.ts. A stub DNS answer decides what a host name "resolves to"; a
// local server on 127.0.0.1 is the only thing that ever receives bytes, and the node:http client is
// spied so "nothing was sent" is checked at the socket layer too, not only at the server.
import { spawn } from "node:child_process";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureProviderPlainHttp,
  setProviderResolveHostForTest,
} from "../src/gateway/provider-fetch";
import { PROVIDER_DRIVERS, PROVIDER_SECRET, STUB_BODY } from "./fixtures/provider-drivers";
import { stallTimeout } from "./stall-timeouts";

interface Seen {
  host: string | undefined;
  auth: string | undefined;
  body: string;
}

let server: http.Server;
let port: number;
let seen: Seen[];
let respond: (res: http.ServerResponse) => void;
let dns: Record<string, string[]>;

function listen(handler: http.RequestListener): Promise<http.Server> {
  const s = http.createServer(handler);
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

beforeEach(async () => {
  seen = [];
  dns = {};
  respond = (res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(STUB_BODY);
  };
  server = await listen((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      seen.push({ host: req.headers.host, auth: req.headers.authorization, body });
      respond(res);
    });
  });
  port = (server.address() as AddressInfo).port;
  configureProviderPlainHttp([]);
  setProviderResolveHostForTest(async (h) => {
    const a = dns[h];
    if (!a) throw new Error("ENOTFOUND");
    return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setProviderResolveHostForTest(undefined);
  configureProviderPlainHttp([]);
  await new Promise<void>((r) => server.close(() => r()));
});

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const x = e as { message?: string; details?: unknown };
    return `${x.message} ${JSON.stringify(x.details ?? "")}`;
  }
  throw new Error("expected the call to be refused");
}

describe.each(PROVIDER_DRIVERS)("$name: plain-http policy at the default transport", (driver) => {
  it("refuses a host that resolves to a PUBLIC address and sends no bytes, unlisted or listed", async () => {
    dns["emb.public.test"] = ["93.184.216.34"];
    for (const hosts of [[], ["emb.public.test"]]) {
      configureProviderPlainHttp(hosts);
      const request = vi.spyOn(http, "request");
      const msg = await failure(driver.call(`http://emb.public.test:${port}`));
      expect(msg).toContain("emb.public.test");
      expect(msg).toContain("93.184.216.34");
      expect(msg).toMatch(/not a private address/);
      expect(msg).not.toContain(PROVIDER_SECRET);
      expect(request).not.toHaveBeenCalled();
      expect(seen).toHaveLength(0);
      request.mockRestore();
    }
  });

  it("refuses a public IP literal outright", async () => {
    const request = vi.spyOn(http, "request");
    await failure(driver.call(`http://93.184.216.34:${port}`));
    expect(request).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });

  it("refuses link-local and the cloud metadata address, listed or not", async () => {
    dns.meta = ["169.254.169.254"];
    configureProviderPlainHttp(["meta"]);
    const request = vi.spyOn(http, "request");
    expect(await failure(driver.call(`http://meta:${port}`))).toContain("169.254.169.254");
    expect(await failure(driver.call(`http://169.254.169.254:${port}`))).toMatch(/refused/);
    expect(request).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });

  it("refuses a host with ONE public answer among private ones", async () => {
    dns.mixed = ["10.0.0.5", "93.184.216.34"];
    await failure(driver.call(`http://mixed:${port}`));
    expect(seen).toHaveLength(0);
  });

  it("an UNLISTED host that resolves private still works, once warned: the deprecation names the host and the config", async () => {
    dns["emb.lan.test"] = ["127.0.0.1"];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await driver.call(`http://emb.lan.test:${port}`);
    await driver.call(`http://emb.lan.test:${port}`);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]?.host).toBe(`emb.lan.test:${port}`);
    const text = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain("DEPRECATED");
    expect(text).toContain("emb.lan.test");
    expect(text).toContain("network.plainHttpHosts");
    expect(text).toContain("next major");
    expect(text).not.toContain(PROVIDER_SECRET);
    // one warning per host, not one per request
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a LISTED host that resolves private works silently", async () => {
    dns["emb.lan.test"] = ["127.0.0.1"];
    configureProviderPlainHttp(["EMB.lan.test"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await driver.call(`http://emb.lan.test:${port}`);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("loopback keeps working with no list, no resolver and no warning", async () => {
    setProviderResolveHostForTest(async () => {
      throw new Error("loopback must not need DNS");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await driver.call(`http://127.0.0.1:${port}`);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses a redirect and never contacts its target", async () => {
    const target = await listen((_q, res) => res.end("{}"));
    const targetHits = vi.fn();
    target.on("request", targetHits);
    const location = `http://127.0.0.1:${(target.address() as AddressInfo).port}/leak`;
    respond = (res) => {
      res.writeHead(307, { location });
      res.end();
    };
    try {
      expect(await failure(driver.call(`http://127.0.0.1:${port}`))).toMatch(/redirect/i);
      expect(seen).toHaveLength(1);
      expect(targetHits).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((r) => target.close(() => r()));
    }
  });

  it("https is unchanged: it goes to the global fetch, with no DNS check and no direct transport", async () => {
    const resolver = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);
    setProviderResolveHostForTest(resolver);
    const globalFetch = vi.fn(async () => new Response(STUB_BODY, { status: 200 }));
    vi.stubGlobal("fetch", globalFetch);
    const request = vi.spyOn(http, "request");
    await driver.call("https://api.example.com");
    expect(globalFetch).toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});

// HTTP_PROXY / ALL_PROXY: only Bun's global fetch honours them, so each case runs in a Bun child
// (the parent runs under Node, where a leak would go unseen). The proxy is a raw TCP sink that
// counts bytes; it must receive none for any plain-http provider call.
const CHILD = fileURLToPath(
  new URL("./fixtures/provider-plain-http-proxy-child.ts", import.meta.url),
);

function runChild(
  driver: string,
  cases: Record<string, unknown>[],
  env: Record<string, string>,
): Promise<{ ok: boolean; message?: string }[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [CHILD, JSON.stringify({ driver, cases })], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), stallTimeout(30_000));
    child.once("error", reject);
    child.once("close", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out.trim().split("\n").pop() ?? "").results);
      } catch {
        reject(new Error(`child printed no result: ${out}`));
      }
    });
  });
}

describe("ambient proxy variables never see plain-http provider traffic", () => {
  let proxy: net.Server;
  let proxyBytes: number;
  const proxySockets = new Set<net.Socket>();
  let proxyEnv: Record<string, string>;

  beforeEach(async () => {
    proxyBytes = 0;
    proxy = net.createServer((sock) => {
      proxySockets.add(sock);
      sock.on("data", (c) => {
        proxyBytes += c.length;
      });
      sock.on("error", () => {});
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    proxyEnv = {
      HTTP_PROXY: url,
      http_proxy: url,
      ALL_PROXY: url,
      all_proxy: url,
      NO_PROXY: "",
      no_proxy: "",
    };
  });

  afterEach(async () => {
    for (const sock of proxySockets) sock.destroy();
    proxySockets.clear();
    await new Promise<void>((r) => proxy.close(() => r()));
  });

  describe.each(PROVIDER_DRIVERS)("$name", (driver) => {
    it(
      "loopback, listed private and unlisted private hosts reach the service directly: the proxy gets zero bytes",
      async () => {
        const cases = [
          { baseUrl: `http://127.0.0.1:${port}` },
          { baseUrl: `http://localhost:${port}`, resolveTo: "127.0.0.1" },
          {
            baseUrl: `http://litellm:${port}`,
            plainHttpHosts: ["litellm"],
            resolveTo: "127.0.0.1",
          },
          { baseUrl: `http://unlisted.lan:${port}`, resolveTo: "127.0.0.1" },
        ];
        const results = await runChild(driver.name, cases, proxyEnv);
        expect(results).toEqual(cases.map(() => ({ ok: true })));
        // every case reached the service (a driver may make more than one request per call)
        expect(seen.length).toBeGreaterThanOrEqual(cases.length);
        expect(proxyBytes).toBe(0);
      },
      stallTimeout(30_000),
    );

    it(
      "a refused public host is not sent to the service or the proxy",
      async () => {
        const [r] = await runChild(
          driver.name,
          [{ baseUrl: `http://emb.public.test:${port}`, resolveTo: "93.184.216.34" }],
          proxyEnv,
        );
        expect(r?.ok).toBe(false);
        expect(r?.message).toMatch(/not a private address/);
        expect(r?.message).not.toContain(PROVIDER_SECRET);
        expect(seen).toHaveLength(0);
        expect(proxyBytes).toBe(0);
      },
      stallTimeout(30_000),
    );
  });
});
