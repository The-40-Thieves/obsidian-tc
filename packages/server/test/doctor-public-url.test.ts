// `doctor` public-URL probe: the checks hosted MCP surfaces (claude.ai, ChatGPT, Gemini Enterprise,
// grok.com, Le Chat, Copilot Studio) depend on, run against a local HTTP fixture with stubbed DNS.
// No real network: every name resolves through the injected resolvers, and every request is routed
// to a fixture server keyed on the Host header. The TLS verdicts are exercised through the request
// seam (a coded transport error), as oidc-pinned-transport.test.ts does for the pinned transport.
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type PublicUrlDeps, publicUrlChecks } from "../src/doctor/public-url";
import {
  type PublicUrlRequest,
  PublicUrlRequestError,
  publicUrlRequest,
} from "../src/doctor/public-url-http";
import type { CheckResult } from "../src/doctor/types";

const MCP = "mcp.example.test";
const AUTH = "auth.example.test";
const RESOURCE = `https://${MCP}/mcp`;
const PRM_URL = `https://${MCP}/.well-known/oauth-protected-resource/mcp`;

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
type Routes = Record<string, Handler>;

const json = (res: http.ServerResponse, status: number, body: unknown, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

/** A healthy deployment: 401 + resource_metadata, a matching PRM, and RFC 8414 AS metadata. */
function healthyRoutes(over: { mcp?: Handler; prm?: Handler; as?: Handler } = {}): Routes {
  const mcp: Handler = (req, res) => {
    if (req.url === "/mcp") {
      return (
        over.mcp ??
        ((_q, r) =>
          json(
            r,
            401,
            { error: "unauthorized" },
            { "www-authenticate": `Bearer realm="obsidian-tc", resource_metadata="${PRM_URL}"` },
          ))
      )(req, res);
    }
    if (req.url === "/.well-known/oauth-protected-resource/mcp") {
      return (
        over.prm ??
        ((_q, r) =>
          json(r, 200, {
            resource: RESOURCE,
            authorization_servers: [`https://${AUTH}`],
            bearer_methods_supported: ["header"],
          }))
      )(req, res);
    }
    return json(res, 404, {});
  };
  const auth: Handler = (req, res) => {
    if (req.url === "/.well-known/oauth-authorization-server") {
      return (
        over.as ??
        ((_q, r) =>
          json(r, 200, {
            issuer: `https://${AUTH}`,
            authorization_endpoint: `https://${AUTH}/oauth/authorize`,
            token_endpoint: `https://${AUTH}/oauth/token`,
          }))
      )(req, res);
    }
    return json(res, 404, {});
  };
  return { [MCP]: mcp, [AUTH]: auth };
}

let port = 0;
let routes: Routes = {};
const server = http.createServer((req, res) => {
  const host = (req.headers.host ?? "").split(":")[0] ?? "";
  const h = routes[host];
  if (h === undefined) return json(res, 502, { error: `no fixture for ${host}` });
  h(req, res);
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  return () => {
    server.close();
  };
});

/** Routes an https://<name>/path request to the fixture, keeping the Host header. */
const fixtureRequest =
  (over: { certValidTo?: number } = {}): PublicUrlRequest =>
  (init) =>
    new Promise((resolve, reject) => {
      const u = new URL(init.url);
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: init.method,
          path: `${u.pathname}${u.search}`,
          headers: { host: u.host, ...init.headers },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
            }
            resolve({
              status: res.statusCode ?? 0,
              headers,
              body: Buffer.concat(chunks).toString("utf8"),
              certValidTo: over.certValidTo ?? Date.now() + 60 * 86_400_000,
            });
          });
        },
      );
      req.on("error", reject);
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });

const DNS_OK = {
  resolve4: async () => ["203.0.113.10"],
  resolve6: async () => [] as string[],
};

const deps = (over: Partial<PublicUrlDeps> = {}): PublicUrlDeps => ({
  ...DNS_OK,
  request: fixtureRequest(),
  ...over,
});

async function run(over: Partial<PublicUrlDeps> = {}, resource = RESOURCE) {
  const checks = publicUrlChecks({ resource, probe: deps(over) });
  const out: Record<string, CheckResult> = {};
  for (const c of checks) out[c.id] = await c.run({ serverVersion: "t" });
  return out;
}

const text = (r: CheckResult | undefined) =>
  JSON.stringify([r?.summary, r?.remediation, r?.issues, r?.details]);

describe("doctor: public-url (skip paths)", () => {
  it("is skipped cleanly (ok, one check) when no public URL is configured", async () => {
    const checks = publicUrlChecks({});
    expect(checks.map((c) => c.id)).toEqual(["public-url"]);
    const r = await checks[0]?.run({ serverVersion: "t" });
    expect(r?.status).toBe("ok");
    expect(r?.summary).toMatch(/auth\.resource/);
  });

  it("is opt-in: a configured URL without a probe reports not probed, and does no I/O", async () => {
    const checks = publicUrlChecks({ resource: RESOURCE });
    expect(checks.map((c) => c.id)).toEqual(["public-url"]);
    const r = await checks[0]?.run({ serverVersion: "t" });
    expect(r?.status).toBe("ok");
    expect(r?.summary).toMatch(/--probe/);
  });

  it("skips a loopback or private host: it is not a public URL", async () => {
    const request = vi.fn();
    for (const resource of [
      "http://127.0.0.1:3000/mcp",
      "https://localhost/mcp",
      "https://10.0.0.5/mcp",
    ]) {
      const checks = publicUrlChecks({ resource, probe: deps({ request }) });
      expect(checks.map((c) => c.id)).toEqual(["public-url"]);
      const r = await checks[0]?.run({ serverVersion: "t" });
      expect(r?.status).toBe("ok");
      expect(r?.summary).toMatch(/not a public/i);
    }
    expect(request).not.toHaveBeenCalled();
  });
});

describe("doctor: public-url (healthy deployment)", () => {
  it("every sub-check passes; the allowlist domains are reported", async () => {
    routes = healthyRoutes();
    const r = await run();
    expect(Object.keys(r).sort()).toEqual([
      "public-url.as-metadata",
      "public-url.challenge",
      "public-url.dns",
      "public-url.prm",
      "public-url.redirects",
      "public-url.tls",
    ]);
    for (const [id, v] of Object.entries(r)) expect([id, v.status]).toEqual([id, "ok"]);
    expect(text(r["public-url.dns"])).toContain("203.0.113.10");
    // Gemini Enterprise's egress allowlist takes the server, authorization and token domains.
    const domains = r["public-url.as-metadata"]?.details?.allowlistDomains;
    expect(domains).toEqual([MCP, AUTH]);
  });

  it("falls back to OpenID discovery when RFC 8414 metadata is absent", async () => {
    const base = healthyRoutes();
    const auth = base[AUTH] as Handler;
    routes = {
      ...base,
      [AUTH]: (req, res) =>
        req.url === "/.well-known/openid-configuration"
          ? json(res, 200, {
              issuer: `https://${AUTH}`,
              authorization_endpoint: `https://${AUTH}/a`,
              token_endpoint: `https://${AUTH}/t`,
            })
          : auth(req, res),
    };
    const r = await run();
    expect(r["public-url.as-metadata"]?.status).toBe("ok");
  });
});

describe("doctor: public-url RED cases", () => {
  it("DNS: an AAAA-only host FAILS (Anthropic egress is IPv4-only) and points at the recipe", async () => {
    routes = healthyRoutes();
    const r = await run({
      resolve4: async () => {
        throw Object.assign(new Error("queryA ENODATA"), { code: "ENODATA" });
      },
      resolve6: async () => ["2001:db8::10"],
    });
    const dns = r["public-url.dns"];
    expect(dns?.status).toBe("fail");
    expect(text(dns)).toMatch(/IPv4/);
    expect(text(dns)).toContain("160.79.104.0/21");
    expect(text(dns)).toContain("/deployment/hosted-clients/#");
  });

  it("DNS: a host with no records at all FAILS", async () => {
    routes = healthyRoutes();
    const r = await run({
      resolve4: async () => {
        throw Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" });
      },
      resolve6: async () => {
        throw Object.assign(new Error("queryAaaa ENOTFOUND"), { code: "ENOTFOUND" });
      },
    });
    expect(r["public-url.dns"]?.status).toBe("fail");
  });

  it("redirect: the MCP endpoint redirecting to ANOTHER host FAILS the redirect check", async () => {
    routes = healthyRoutes({
      mcp: (_q, res) => {
        res.writeHead(301, { location: "https://other.example.test/mcp" });
        res.end();
      },
    });
    const r = await run();
    expect(r["public-url.redirects"]?.status).toBe("fail");
    expect(text(r["public-url.redirects"])).toContain("other.example.test");
    expect(r["public-url.challenge"]?.status).not.toBe("ok");
  });

  it("redirect: a same-host redirect (a trailing-slash rewrite) is a WARNING, not a pass", async () => {
    routes = healthyRoutes({
      mcp: (_q, res) => {
        res.writeHead(308, { location: `https://${MCP}/mcp/` });
        res.end();
      },
    });
    const r = await run();
    expect(r["public-url.redirects"]?.status).toBe("warning");
  });

  it("challenge: a 401 WITHOUT resource_metadata FAILS", async () => {
    routes = healthyRoutes({
      mcp: (_q, res) => json(res, 401, {}, { "www-authenticate": 'Bearer realm="obsidian-tc"' }),
    });
    const r = await run();
    expect(r["public-url.challenge"]?.status).toBe("fail");
    expect(text(r["public-url.challenge"])).toContain("resource_metadata");
    expect(text(r["public-url.challenge"])).toContain("authorizationServers");
  });

  it("challenge: a 200 without a token FAILS (the endpoint is not protected)", async () => {
    routes = healthyRoutes({ mcp: (_q, res) => json(res, 200, {}) });
    const r = await run();
    expect(r["public-url.challenge"]?.status).toBe("fail");
  });

  it("PRM: a `resource` that differs from the URL FAILS and names both", async () => {
    routes = healthyRoutes({
      prm: (_q, res) =>
        json(res, 200, {
          resource: `https://${MCP}/other`,
          authorization_servers: [`https://${AUTH}`],
        }),
    });
    const r = await run();
    const prm = r["public-url.prm"];
    expect(prm?.status).toBe("fail");
    expect(text(prm)).toContain(`https://${MCP}/other`);
    expect(text(prm)).toContain(RESOURCE);
  });

  it("PRM: missing authorization_servers FAILS", async () => {
    routes = healthyRoutes({ prm: (_q, res) => json(res, 200, { resource: RESOURCE }) });
    const r = await run();
    expect(r["public-url.prm"]?.status).toBe("fail");
  });

  it("AS metadata: absent at both well-known locations FAILS", async () => {
    routes = { ...healthyRoutes(), [AUTH]: (_q, res) => json(res, 404, {}) };
    const r = await run();
    expect(r["public-url.as-metadata"]?.status).toBe("fail");
    expect(text(r["public-url.as-metadata"])).toContain(AUTH);
  });

  it("AS metadata: an issuer that is not the authorization server URL FAILS", async () => {
    routes = healthyRoutes({
      as: (_q, res) =>
        json(res, 200, {
          issuer: "https://elsewhere.example.test",
          authorization_endpoint: `https://${AUTH}/a`,
          token_endpoint: `https://${AUTH}/t`,
        }),
    });
    const r = await run();
    expect(r["public-url.as-metadata"]?.status).toBe("fail");
  });

  it("AS metadata: a cross-host redirect on the metadata fetch FAILS the redirect check", async () => {
    routes = {
      ...healthyRoutes(),
      [AUTH]: (_q, res) => {
        res.writeHead(302, { location: "https://login.example.test/.well-known/x" });
        res.end();
      },
    };
    const r = await run();
    expect(r["public-url.redirects"]?.status).toBe("fail");
    expect(text(r["public-url.redirects"])).toContain("login.example.test");
  });

  it("TLS: an untrusted certificate FAILS and the checks behind it are not claimed to pass", async () => {
    routes = healthyRoutes();
    const r = await run({
      request: async () => {
        throw new PublicUrlRequestError("DEPTH_ZERO_SELF_SIGNED_CERT", "self-signed certificate");
      },
    });
    expect(r["public-url.tls"]?.status).toBe("fail");
    expect(text(r["public-url.tls"])).toMatch(/publicly trusted/);
    for (const id of ["public-url.challenge", "public-url.prm", "public-url.as-metadata"]) {
      expect([id, r[id]?.status]).toEqual([id, "warning"]);
    }
  });

  it("TLS: a certificate expiring within 14 days is a WARNING", async () => {
    routes = healthyRoutes();
    const r = await run({ request: fixtureRequest({ certValidTo: Date.now() + 3 * 86_400_000 }) });
    expect(r["public-url.tls"]?.status).toBe("warning");
  });

  it("TLS: a plain http:// resource FAILS (hosted clients need https)", async () => {
    const r = await run({}, `http://${MCP}/mcp`);
    expect(r["public-url.tls"]?.status).toBe("fail");
  });
});

describe("doctor: public-url never throws", () => {
  it("survives a rejection that is not an Error, a throwing resolver and a non-JSON PRM", async () => {
    routes = healthyRoutes({ prm: (_q, res) => res.end("<html>not json</html>") });
    const r = await run({
      resolve4: () => {
        throw "sync boom";
      },
      resolve6: () => Promise.reject("boom"),
    });
    expect(r["public-url.dns"]?.status).toBe("fail");
    // With no address to connect to, nothing is fetched and the rest is not claimed to pass.
    expect(r["public-url.tls"]?.status).toBe("fail");
    expect(r["public-url.prm"]?.status).toBe("warning");
    const r1 = await run();
    expect(r1["public-url.prm"]?.status).toBe("fail");
    const r2 = await run({ request: () => Promise.reject(42) });
    expect(r2["public-url.tls"]?.status).toBe("fail");
  });

  it("times out a request that never answers instead of hanging", async () => {
    routes = healthyRoutes();
    const started = Date.now();
    const checks = publicUrlChecks({
      resource: RESOURCE,
      probe: deps({ request: () => new Promise(() => undefined), timeoutMs: 50 }),
    });
    const out: CheckResult[] = [];
    for (const c of checks) out.push(await c.run({ serverVersion: "t" }));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(out.some((o) => o.status === "fail" && /timed out/.test(o.summary))).toBe(true);
  });
});

describe("publicUrlRequest (default transport)", () => {
  afterEach(() => vi.restoreAllMocks());

  function fakeHttps(step: "selfsigned" | { status: number; location?: string; body?: string }) {
    const calls: Record<string, unknown>[] = [];
    vi.spyOn(https, "request").mockImplementation(((opts: Record<string, unknown>) => {
      calls.push(opts);
      const req = new EventEmitter() as EventEmitter & {
        end: () => void;
        write: () => void;
        destroy: () => void;
      };
      req.destroy = () => undefined;
      req.write = () => undefined;
      req.end = () =>
        queueMicrotask(() => {
          if (step === "selfsigned") {
            req.emit(
              "error",
              Object.assign(new Error("self-signed certificate"), {
                code: "DEPTH_ZERO_SELF_SIGNED_CERT",
              }),
            );
            return;
          }
          const res = Object.assign(Readable.from([Buffer.from(step.body ?? "{}")]), {
            statusCode: step.status,
            headers: step.location === undefined ? {} : { location: step.location },
            socket: { getPeerCertificate: () => ({ valid_to: "Jan  1 00:00:00 2099 GMT" }) },
          });
          req.emit("response", res);
        });
      return req;
    }) as unknown as typeof https.request);
    return calls;
  }

  it("surfaces a TLS verification failure as a coded PublicUrlRequestError", async () => {
    fakeHttps("selfsigned");
    await expect(
      publicUrlRequest({ url: RESOURCE, method: "POST", address: "203.0.113.10" }),
    ).rejects.toMatchObject({
      name: "PublicUrlRequestError",
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
    });
  });

  it("verifies the certificate and does not follow a redirect", async () => {
    const calls = fakeHttps({ status: 301, location: "https://other.example.test/" });
    const res = await publicUrlRequest({ url: RESOURCE, method: "GET", address: "203.0.113.10" });
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe("https://other.example.test/");
    expect(res.certValidTo).toBeGreaterThan(Date.now());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.rejectUnauthorized).not.toBe(false);
  });
});
