// The public-url probe fetches URLs it reads from remote documents: the PRM pointer in a 401, the
// `authorization_servers` in the PRM, and (reported, never followed) redirect Locations. A hostile or
// misconfigured public endpoint must not steer the server's own network position at internal
// addresses (loopback, RFC 1918, link-local / cloud metadata, CGNAT, ULA, IPv4-mapped). Every fetch
// resolves its host first, refuses any non-public answer, and connects to the address it validated.
import { EventEmitter } from "node:events";
import https from "node:https";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publicUrlChecks } from "../src/doctor/public-url";
import {
  type PublicUrlRequestInit,
  type PublicUrlResponse,
  publicUrlRequest,
} from "../src/doctor/public-url-http";
import type { CheckResult } from "../src/doctor/types";

const MCP = "mcp.example.test";
const RESOURCE = `https://${MCP}/mcp`;
const PRM_URL = `https://${MCP}/.well-known/oauth-protected-resource/mcp`;
const PUBLIC = "203.0.113.10";

const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  ({
    status,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    certValidTo: Date.now() + 90 * 86_400_000,
  }) satisfies PublicUrlResponse;

interface Rig {
  requested: PublicUrlRequestInit[];
  run: () => Promise<Record<string, CheckResult>>;
}

/** No sockets: a responder keyed on URL, a recording request and a per-host resolver. */
function rig(
  responder: (url: string) => PublicUrlResponse,
  dns: Record<string, string[]> = {},
): Rig {
  const requested: PublicUrlRequestInit[] = [];
  return {
    requested,
    run: async () => {
      const checks = publicUrlChecks({
        resource: RESOURCE,
        probe: {
          resolve4: async (h) => dns[h] ?? [PUBLIC],
          resolve6: async () => [],
          request: async (init) => {
            requested.push(init);
            return responder(init.url);
          },
        },
      });
      const out: Record<string, CheckResult> = {};
      for (const c of checks) out[c.id] = await c.run({ serverVersion: "t" });
      return out;
    },
  };
}

const challenge = (pointer = PRM_URL) =>
  reply(401, {}, { "www-authenticate": `Bearer resource_metadata="${pointer}"` });

const INTERNAL_AS = [
  "http://169.254.169.254",
  "https://169.254.169.254",
  "https://127.0.0.1:8080",
  "https://[::1]",
  "https://[::ffff:127.0.0.1]",
  "https://[::ffff:a9fe:a9fe]",
  "https://[fd00::1]",
  "https://10.1.2.3",
  "https://192.168.1.1",
  "https://100.64.0.1",
  "https://localhost",
  "https://metadata.internal.test",
];
const DNS_INTERNAL = { "metadata.internal.test": ["169.254.169.254"] };

describe("public-url probe refuses to fetch internal addresses", () => {
  it.each(INTERNAL_AS)("a PRM naming %s as authorization server is never fetched", async (as) => {
    const r = rig(
      (url) =>
        url === RESOURCE
          ? challenge()
          : reply(200, { resource: RESOURCE, authorization_servers: [as] }),
      DNS_INTERNAL,
    );
    const out = await r.run();
    const asHost = new URL(as).hostname.replace(/^\[|\]$/g, "");
    expect(r.requested.map((q) => q.url).filter((u) => u.includes(asHost))).toEqual([]);
    expect(out["public-url.as-metadata"]?.status).toBe("fail");
    expect(out["public-url.as-metadata"]?.summary).toMatch(/non-public|https/);
  });

  it.each([
    "https://169.254.169.254/latest/meta-data/",
    "https://[::ffff:10.0.0.1]/prm",
    "http://mcp.example.test/prm",
    "https://metadata.internal.test/prm",
  ])("a 401 whose resource_metadata is %s is never fetched", async (pointer) => {
    const r = rig((url) => (url === RESOURCE ? challenge(pointer) : reply(200, {})), DNS_INTERNAL);
    const out = await r.run();
    expect(r.requested.map((q) => q.url)).toEqual([RESOURCE]);
    expect(out["public-url.prm"]?.status).toBe("fail");
  });

  it("a host with ANY non-public answer is refused, even beside a public one", async () => {
    const r = rig(
      (url) =>
        url === RESOURCE
          ? challenge()
          : reply(200, {
              resource: RESOURCE,
              authorization_servers: ["https://auth.example.test"],
            }),
      { "auth.example.test": [PUBLIC, "10.0.0.5"] },
    );
    const out = await r.run();
    expect(r.requested.some((q) => new URL(q.url).hostname === "auth.example.test")).toBe(false);
    expect(out["public-url.as-metadata"]?.status).toBe("fail");
  });

  it("a redirect Location is reported and never requested", async () => {
    const r = rig((url) =>
      url === RESOURCE ? reply(302, {}, { location: "http://169.254.169.254/latest" }) : reply(404),
    );
    const out = await r.run();
    expect(r.requested.map((q) => q.url)).toEqual([RESOURCE]);
    expect(out["public-url.redirects"]?.status).toBe("fail");
    expect(out["public-url.redirects"]?.summary).toContain("169.254.169.254");
  });

  it("every request connects to the address it validated", async () => {
    const r = rig(
      (url) =>
        url === RESOURCE
          ? challenge()
          : reply(200, {
              resource: RESOURCE,
              authorization_servers: ["https://auth.example.test"],
            }),
      { "auth.example.test": ["198.51.100.7"] },
    );
    await r.run();
    expect(r.requested.length).toBeGreaterThanOrEqual(3);
    for (const q of r.requested) {
      const expected = new URL(q.url).hostname === "auth.example.test" ? "198.51.100.7" : PUBLIC;
      expect([q.url, q.address]).toEqual([q.url, expected]);
    }
  });
});

describe("publicUrlRequest pins the connection", () => {
  afterEach(() => vi.restoreAllMocks());

  it("connects to the validated address with SNI and Host on the name", async () => {
    const calls: Record<string, unknown>[] = [];
    vi.spyOn(https, "request").mockImplementation(((opts: Record<string, unknown>) => {
      calls.push(opts);
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      req.destroy = () => undefined;
      req.end = () =>
        queueMicrotask(() =>
          req.emit(
            "response",
            Object.assign(Readable.from([Buffer.from("{}")]), { statusCode: 200, headers: {} }),
          ),
        );
      return req;
    }) as unknown as typeof https.request);
    await publicUrlRequest({ url: RESOURCE, method: "GET", address: PUBLIC });
    expect(calls[0]).toMatchObject({
      hostname: PUBLIC,
      servername: MCP,
      rejectUnauthorized: true,
      headers: { host: MCP },
    });
  });

  it("refuses a non-https URL without touching the network", async () => {
    const spy = vi.spyOn(https, "request");
    await expect(
      publicUrlRequest({ url: "http://mcp.example.test/mcp", method: "GET", address: PUBLIC }),
    ).rejects.toMatchObject({ code: "ENOTHTTPS" });
    expect(spy).not.toHaveBeenCalled();
  });
});
