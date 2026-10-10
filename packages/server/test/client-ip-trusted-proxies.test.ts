// Trusted proxies (`transports.http.trustedProxies` / `forwardedHeader`): the client address the
// per-source limits key on is the TCP peer, unless the peer is a proxy the operator named, and then
// it is the address that proxy forwarded. Incidents these cases come from: behind a Cloudflare
// Tunnel on the same host every client was the loopback peer, so one flood spent the shared CIMD
// (10/min) and passkey login/options (60/min) buckets for everybody; and the opposite mistake, a
// header read from any peer, would let a client pick its own bucket by writing it.
import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import type { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { FolderAcl } from "../src/acl";
import "../src/auth/as-issuing";
import { claimOperator } from "../src/auth/as-operator-store";
import { hashPassword } from "../src/auth/as-password";
import { createClientIpResolver, socketClientIp } from "../src/auth/client-ip";
import { authKeysDir, createAuthRegistry } from "../src/auth/registry";
import { provisionAuthDb, provisionCacheDb, provisionOauthDb } from "../src/db/provision";
import { ToolRegistry } from "../src/mcp/registry";
import { createHttpApp, type HttpApp } from "../src/transports/http";
import { get, ISSUER, Jar, type OperatorFixture, PASSWORD, RESOURCE } from "./as-operator-harness";
import { openMemoryDb } from "./helpers";
import { makeTempDir, rmTemp } from "./tmp";

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

const envOf = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });

/** What the resolver returns for a request from `peer` carrying `headers`. */
function resolve(
  policy: Parameters<typeof createClientIpResolver>[0],
  peer: string | undefined,
  headers: Array<[string, string]> = [],
): string | undefined {
  const h = new Headers();
  for (const [k, v] of headers) h.append(k, v);
  const c = {
    env: peer === undefined ? undefined : envOf(peer),
    req: { raw: new Request("https://x.test/", { headers: h }) },
  };
  return createClientIpResolver(policy)(c as never);
}

const LOOPBACK_PROXY = { trustedProxies: ["127.0.0.1", "::1"] };
const xff = (v: string): Array<[string, string]> => [["x-forwarded-for", v]];

describe("untrusted peers: no forwarded header is ever read", () => {
  it("RED: with no trusted proxy, X-Forwarded-For and CF-Connecting-IP are ignored (today's behaviour)", () => {
    const headers: Array<[string, string]> = [
      ["x-forwarded-for", "198.51.100.1"],
      ["cf-connecting-ip", "198.51.100.2"],
    ];
    expect(resolve(undefined, "203.0.113.5", headers)).toBe("203.0.113.5");
    expect(resolve({}, "203.0.113.5", headers)).toBe("203.0.113.5");
    expect(
      resolve({ trustedProxies: [], forwardedHeader: "cf-connecting-ip" }, "203.0.113.5", headers),
    ).toBe("203.0.113.5");
    // Behind a loopback peer with nothing trusted, the client stays unattributed.
    expect(resolve(undefined, "127.0.0.1", headers)).toBeUndefined();
  });

  it("RED: a spoofed X-Forwarded-For from a peer that is not listed is ignored", () => {
    expect(resolve(LOOPBACK_PROXY, "203.0.113.5", xff("198.51.100.1"))).toBe("203.0.113.5");
    expect(resolve(LOOPBACK_PROXY, "203.0.113.5", xff("127.0.0.1"))).toBe("203.0.113.5");
    // A neighbour of a listed host, and a listed CIDR's outside, are not trusted either.
    expect(resolve({ trustedProxies: ["10.0.0.0/24"] }, "10.0.1.1", xff("198.51.100.1"))).toBe(
      "10.0.1.1",
    );
  });

  it("RED: CF-Connecting-IP from a peer that is not listed is ignored, in either mode", () => {
    const cf: Array<[string, string]> = [["cf-connecting-ip", "198.51.100.9"]];
    expect(
      resolve({ ...LOOPBACK_PROXY, forwardedHeader: "cf-connecting-ip" }, "203.0.113.5", cf),
    ).toBe("203.0.113.5");
    expect(resolve(LOOPBACK_PROXY, "203.0.113.5", cf)).toBe("203.0.113.5");
  });

  it("an unknown peer (no socket) stays unattributed whatever the headers say", () => {
    expect(resolve(LOOPBACK_PROXY, undefined, xff("198.51.100.1"))).toBeUndefined();
  });
});

describe("trusted peer: X-Forwarded-For", () => {
  it("takes the forwarded client address", () => {
    expect(resolve(LOOPBACK_PROXY, "127.0.0.1", xff("198.51.100.1"))).toBe("198.51.100.1");
    expect(resolve(LOOPBACK_PROXY, "::1", xff("198.51.100.1"))).toBe("198.51.100.1");
    expect(resolve(LOOPBACK_PROXY, "::ffff:127.0.0.1", xff("198.51.100.1"))).toBe("198.51.100.1");
  });

  it("takes the right-most hop that is not itself a trusted proxy", () => {
    const policy = { trustedProxies: ["127.0.0.1", "10.0.0.0/8"] };
    // client-written left part, the real client, then an internal proxy the peer fronts for
    expect(resolve(policy, "127.0.0.1", xff("6.6.6.6, 198.51.100.1, 10.1.2.3"))).toBe(
      "198.51.100.1",
    );
    // a client that writes a trusted-looking value in front gains nothing
    expect(resolve(policy, "127.0.0.1", xff("10.9.9.9, 198.51.100.1"))).toBe("198.51.100.1");
    // an attacker-supplied left hop never wins over what the proxy appended
    expect(resolve(policy, "127.0.0.1", xff("198.51.100.200, 198.51.100.1"))).toBe("198.51.100.1");
  });

  it("every hop trusted: no client address, so the peer's (unattributed) bucket", () => {
    expect(resolve(LOOPBACK_PROXY, "127.0.0.1", xff("127.0.0.1, ::1"))).toBeUndefined();
  });

  it("joins several X-Forwarded-For headers and reads the last hop of the last one", () => {
    expect(
      resolve(LOOPBACK_PROXY, "127.0.0.1", [
        ["x-forwarded-for", "6.6.6.6"],
        ["x-forwarded-for", "198.51.100.1"],
      ]),
    ).toBe("198.51.100.1");
  });

  it("tolerates whitespace, a port, brackets and quotes; an IPv6 client is canonical", () => {
    expect(resolve(LOOPBACK_PROXY, "127.0.0.1", xff("   198.51.100.1:51234  "))).toBe(
      "198.51.100.1",
    );
    const v6 = resolve(LOOPBACK_PROXY, "127.0.0.1", xff("[2001:db8::7]:443"));
    expect(v6).toBe(resolve(LOOPBACK_PROXY, "127.0.0.1", xff("2001:DB8:0:0:0:0:0:7")));
    expect(v6).toBe(resolve(LOOPBACK_PROXY, "127.0.0.1", xff('"[2001:db8::7]"')));
    expect(resolve(LOOPBACK_PROXY, "127.0.0.1", xff("::ffff:198.51.100.1"))).toBe("198.51.100.1");
  });

  it("a loopback client address is as unattributed as a loopback peer", () => {
    const policy = { trustedProxies: ["172.18.0.0/16"] };
    expect(resolve(policy, "172.18.0.2", xff("127.0.0.1"))).toBeUndefined();
  });

  it("RED: a malformed header falls back to the peer, never to a guess", () => {
    for (const bad of [
      "",
      " ",
      ",",
      "unknown",
      "_hidden",
      "garbage",
      "198.51.100.1, ",
      "198.51.100.1,, 198.51.100.2x",
      "198.51.100.256",
      "1.2.3",
      "198.51.100.1:99999",
      "for=198.51.100.1",
      "[2001:db8::7",
      "198.51.100.1 198.51.100.2",
      "6.6.6.6, unknown",
    ]) {
      // peer is loopback: the fallback is "unattributed", i.e. undefined
      expect(resolve(LOOPBACK_PROXY, "127.0.0.1", xff(bad)), JSON.stringify(bad)).toBeUndefined();
    }
    expect(resolve(LOOPBACK_PROXY, "127.0.0.1", [])).toBeUndefined();
    // a non-loopback trusted peer falls back to itself
    expect(resolve({ trustedProxies: ["10.0.0.5"] }, "10.0.0.5", xff("garbage"))).toBe("10.0.0.5");
  });

  it("garbage to the LEFT of a well-formed appended hop does not matter", () => {
    expect(resolve(LOOPBACK_PROXY, "127.0.0.1", xff("not an ip, 198.51.100.1"))).toBe(
      "198.51.100.1",
    );
  });

  it("matches a CIDR entry (a docker bridge) and an IPv6 CIDR", () => {
    expect(resolve({ trustedProxies: ["172.18.0.0/16"] }, "172.18.0.2", xff("198.51.100.1"))).toBe(
      "198.51.100.1",
    );
    expect(resolve({ trustedProxies: ["fd00::/8"] }, "fd12::2", xff("198.51.100.1"))).toBe(
      "198.51.100.1",
    );
  });

  it("an IPv4 entry trusts the same peer reported IPv4-mapped, and the reverse", () => {
    expect(resolve({ trustedProxies: ["::ffff:10.0.0.5"] }, "10.0.0.5", xff("198.51.100.1"))).toBe(
      "198.51.100.1",
    );
    expect(resolve({ trustedProxies: ["10.0.0.5"] }, "::ffff:10.0.0.5", xff("198.51.100.1"))).toBe(
      "198.51.100.1",
    );
  });
});

describe("Cloudflare mode: CF-Connecting-IP", () => {
  const cf = { ...LOOPBACK_PROXY, forwardedHeader: "cf-connecting-ip" as const };
  const header = (v: string): Array<[string, string]> => [["cf-connecting-ip", v]];

  it("RED: read only in Cloudflare mode, and only from a trusted peer", () => {
    expect(resolve(cf, "127.0.0.1", header("198.51.100.1"))).toBe("198.51.100.1");
    expect(resolve(cf, "203.0.113.5", header("198.51.100.1"))).toBe("203.0.113.5");
    // default mode never reads it, even from a trusted peer
    expect(resolve(LOOPBACK_PROXY, "127.0.0.1", header("198.51.100.1"))).toBeUndefined();
  });

  it("does not read X-Forwarded-For in Cloudflare mode, even from the trusted peer", () => {
    expect(resolve(cf, "127.0.0.1", xff("198.51.100.1"))).toBeUndefined();
    expect(
      resolve(cf, "127.0.0.1", [...xff("6.6.6.6"), ["cf-connecting-ip", "198.51.100.1"]]),
    ).toBe("198.51.100.1");
  });

  it("an IPv6 client is read and canonicalised", () => {
    expect(resolve(cf, "127.0.0.1", header("2001:db8::7"))).toBe(
      resolve(cf, "127.0.0.1", header("2001:0db8:0:0:0:0:0:7")),
    );
    expect(resolve(cf, "127.0.0.1", header("2001:db8::7"))).not.toBeUndefined();
  });

  it("RED: a malformed or multi-valued header falls back to the peer", () => {
    for (const bad of [
      "",
      "unknown",
      "198.51.100.1, 198.51.100.2",
      "198.51.100.1:80x",
      "198.51.100.300",
      "evil",
    ]) {
      expect(resolve(cf, "127.0.0.1", header(bad)), JSON.stringify(bad)).toBeUndefined();
    }
    expect(resolve({ ...cf, trustedProxies: ["10.0.0.5"] }, "10.0.0.5", header("evil"))).toBe(
      "10.0.0.5",
    );
  });
});

describe("construction", () => {
  it("refuses a malformed trusted-proxy entry rather than dropping it", () => {
    expect(() => createClientIpResolver({ trustedProxies: ["proxy.example.com"] })).toThrow(
      /trusted proxy/i,
    );
    expect(() => createClientIpResolver({ trustedProxies: ["0.0.0.0/0"] })).toThrow();
  });

  it("socketClientIp is the resolver with nothing trusted", () => {
    const c = {
      env: envOf("203.0.113.5"),
      req: {
        raw: new Request("https://x.test/", { headers: { "x-forwarded-for": "198.51.100.1" } }),
      },
    };
    expect(socketClientIp(c as never)).toBe("203.0.113.5");
  });
});

// ---- over HTTP, through the real limiters ---------------------------------------------------------

/** The real HTTP app (operator routes and authorization-server routes mounted by createHttpApp itself). */
async function httpFixture(http: { trustedProxies?: string[]; forwardedHeader?: string }) {
  const dir = makeTempDir("client-ip-");
  closers.push(() => rmTemp(dir));
  const auth = ServerConfigSchema.parse({
    vaults: [{ id: "v1", path: dir }],
    auth: {
      mode: "jwt",
      jwtSecret: "test-only-secret-not-a-real-credential-0123456789",
      resource: RESOURCE,
      as: { enabled: true, issuer: ISSUER, dynamicRegistration: true },
    },
  }).auth as never;
  const authDb = openMemoryDb();
  provisionAuthDb(authDb);
  const registry = createAuthRegistry(authDb, { keysDir: authKeysDir(dir) });
  const oauthDb = openMemoryDb();
  provisionOauthDb(oauthDb, { version: "t" });
  claimOperator(oauthDb, {
    username: "operator",
    passwordHash: await hashPassword(PASSWORD),
    now: Date.now(),
  });
  const cacheDb = openMemoryDb();
  provisionCacheDb(cacheDb);
  const handle: HttpApp = createHttpApp({
    name: "obsidian-tc",
    version: "t",
    registry: new ToolRegistry(),
    auth,
    db: cacheDb,
    oauthDb,
    authRegistry: registry,
    vaultId: "v1",
    acl: new FolderAcl({ readOnly: false, defaultScopes: [], rules: [] }),
    enableDnsRebindingProtection: false,
    ...http,
  } as never);
  closers.push(() => handle.close());
  let peer = "127.0.0.1";
  const op = {
    issuer: ISSUER,
    url: (path: string) => `${ISSUER}${path}`,
    app: {
      request: (input: string | Request, init?: RequestInit) =>
        handle.app.request(input, init, envOf(peer)),
    } as unknown as Hono,
  } as unknown as OperatorFixture;
  return {
    op,
    from: (p: string) => {
      peer = p;
    },
  };
}

async function loginCsrf(op: OperatorFixture, jar: Jar): Promise<string> {
  const page = await get(op, "/oauth/login", jar);
  return /id="passkey"[^>]*data-csrf="([^"]+)"/.exec(page.text)?.[1] ?? "";
}

async function options(
  op: OperatorFixture,
  jar: Jar,
  csrf: string,
  headers: Record<string, string>,
) {
  const res = await op.app.request(op.url("/oauth/passkey/login/options"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: op.issuer,
      "x-csrf-token": csrf,
      cookie: jar.header(),
      ...headers,
    },
    body: "{}",
  });
  return res.status;
}

async function registerStatus(op: OperatorFixture, headers: Record<string, string>) {
  const res = await op.app.request(op.url("/oauth/register"), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });
  return res.status;
}

describe("through the HTTP app and the real limiters", () => {
  it("RED: behind a trusted proxy two forwarded clients have separate passkey login/options buckets", async () => {
    const { op, from } = await httpFixture({ trustedProxies: ["127.0.0.1"] });
    from("127.0.0.1");
    const jar = new Jar();
    const csrf = await loginCsrf(op, jar);
    expect(csrf).not.toBe("");
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      statuses.push(await options(op, jar, csrf, { "x-forwarded-for": "198.51.100.1" }));
    }
    // client A is cut off by its own per-source budget (20 a minute), not the shared one (60)
    expect(statuses).toContain(429);
    expect(statuses.indexOf(429)).toBeLessThanOrEqual(21);
    // client B, behind the same proxy, still gets through
    expect(await options(op, jar, csrf, { "x-forwarded-for": "198.51.100.2" })).toBe(200);
  });

  it("RED: today's behaviour is unchanged with no trusted proxy: a loopback peer is one shared bucket", async () => {
    const { op, from } = await httpFixture({});
    from("127.0.0.1");
    const jar = new Jar();
    const csrf = await loginCsrf(op, jar);
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      statuses.push(await options(op, jar, csrf, { "x-forwarded-for": `198.51.100.${i + 1}` }));
    }
    // 25 different forwarded "clients" are still one source with the shared allowance (60)
    expect(statuses.every((s) => s === 200)).toBe(true);
    const more: number[] = [];
    for (let i = 0; i < 40; i++) {
      more.push(await options(op, jar, csrf, { "x-forwarded-for": "198.51.100.200" }));
    }
    expect(more).toContain(429);
  });

  it("RED: rotating X-Forwarded-For from a peer that is not trusted does not escape that peer's budget", async () => {
    const { op, from } = await httpFixture({ trustedProxies: ["127.0.0.1"] });
    from("203.0.113.9");
    const jar = new Jar();
    const csrf = await loginCsrf(op, jar);
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) {
      statuses.push(await options(op, jar, csrf, { "x-forwarded-for": `198.51.100.${i + 1}` }));
    }
    expect(statuses).toContain(429);
    expect(statuses.indexOf(429)).toBeLessThanOrEqual(21);
  });

  it("RED: the authorization-server routes (registration budget) key on the forwarded client too", async () => {
    const { op, from } = await httpFixture({
      trustedProxies: ["127.0.0.1"],
      forwardedHeader: "cf-connecting-ip",
    });
    from("127.0.0.1");
    const a = { "cf-connecting-ip": "198.51.100.1" };
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push(await registerStatus(op, a));
    // 10 an hour per source: A runs out, B is a different source
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(await registerStatus(op, { "cf-connecting-ip": "198.51.100.2" })).not.toBe(429);
    // the same header, sent by a peer that is not the proxy, buys nothing
    from("203.0.113.9");
    const spoof: number[] = [];
    for (let i = 0; i < 12; i++) {
      spoof.push(await registerStatus(op, { "cf-connecting-ip": `198.51.100.${50 + i}` }));
    }
    expect(spoof.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});
