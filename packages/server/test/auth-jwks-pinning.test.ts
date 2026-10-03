// JWT mode's remote key set (`auth.jwksUri`) used to be read by jose's own fetch: resolve the name,
// then connect to the name again, so a record that flips between the two lookups (DNS rebinding)
// could steer the request at a private or metadata address, and the body had no size cap. It now
// goes through the same public-host check and pinned transport as OIDC discovery:
//   - https + public addresses only by default, connected to the address that was validated;
//   - a host in `network.plainHttpHosts` may be http:// or private (the provider rules), loopback
//     needs no entry, the tailnet range counts only for a listed host, metadata is never allowed;
//   - an UNLISTED host that resolves only to private addresses keeps working for one release, with
//     a deprecation warning that names the host and the config to add;
//   - redirects are refused and the body is capped.
// The socket layer is observed through node:http(s).request, so no server or certificate is needed.
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildJwtVerifier } from "../src/auth/jwt-boot";
import { createTokenVerifier } from "../src/auth/verifier";
import {
  configureProviderPlainHttp,
  setProviderResolveHostForTest,
} from "../src/gateway/provider-fetch";

interface Call {
  scheme: "http" | "https";
  host: string;
  port: number;
  servername?: string;
  headers: Record<string, string>;
  path: string;
}

type Step = { status?: number; body?: string; location?: string };

let jwksBody = "";
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  privateKey = pair.privateKey;
  jwksBody = JSON.stringify({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }],
  });
});

const token = () =>
  new SignJWT({ sub: "alice" })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setExpirationTime("5m")
    .sign(privateKey);

/** Stand-ins for node:http(s).request. `plan` answers per call, in order (the last repeats). */
function fakeNet(plan: Step[] = [{}]) {
  const calls: Call[] = [];
  const make = (scheme: "http" | "https") =>
    vi.spyOn(scheme === "https" ? https : http, "request").mockImplementation(((
      opts: Omit<Call, "scheme">,
    ) => {
      calls.push({ ...opts, scheme });
      const step = plan[Math.min(calls.length - 1, plan.length - 1)] ?? {};
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
      req.destroy = () => undefined;
      req.end = () => {
        queueMicrotask(() => {
          const res = Object.assign(Readable.from([Buffer.from(step.body ?? jwksBody)]), {
            statusCode: step.status ?? 200,
            statusMessage: "",
            rawHeaders:
              step.location === undefined
                ? ["content-type", "application/json"]
                : ["location", step.location],
            headers: step.location === undefined ? {} : { location: step.location },
          });
          req.emit("response", res);
        });
      };
      return req;
    }) as unknown as typeof https.request);
  make("https");
  make("http");
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  configureProviderPlainHttp([]);
  setProviderResolveHostForTest(undefined);
});

const v4 = (address: string) => ({ address, family: 4 as const });
const answer = (...addrs: string[]) => addrs.map(v4);

function verifierFor(
  jwksUri: string,
  net: {
    plainHttpHosts?: string[];
    resolveHost?: (h: string) => Promise<{ address: string; family: 4 | 6 }[]>;
    warn?: (m: string) => void;
  } = {},
) {
  return createTokenVerifier({
    jwksUri,
    jwksNetwork: {
      plainHttpHosts: net.plainHttpHosts ?? [],
      resolveHost: net.resolveHost ?? (async () => answer("93.184.216.34")),
      ...(net.warn !== undefined ? { warn: net.warn } : {}),
    },
  });
}

const reasonOf = (p: Promise<unknown>) =>
  p.then(
    () => "accepted",
    (e: { reason?: string }) => e.reason ?? "threw",
  );

describe("jwt-mode jwksUri is pinned to the validated address", () => {
  it("rebinding: public on the check, metadata on the next lookup -> connects to the public address, one lookup", async () => {
    const calls = fakeNet();
    const globalFetch = vi.fn(async () => new Response(jwksBody));
    vi.stubGlobal("fetch", globalFetch);
    let lookups = 0;
    const v = verifierFor("https://as.test/.well-known/jwks.json", {
      resolveHost: async () => answer(++lookups === 1 ? "93.184.216.34" : "169.254.169.254"),
    });
    expect((await v.verify(await token())).caller).toBe("alice");
    expect(lookups).toBe(1);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      scheme: "https",
      host: "93.184.216.34",
      port: 443,
      servername: "as.test",
      path: "/.well-known/jwks.json",
    });
    expect(calls[0]?.headers.host).toBe("as.test");
  });

  it("a name that resolves to a private address is refused by default, nothing is sent", async () => {
    const calls = fakeNet();
    // Mixed answer: a public address does not launder a private one.
    const v = verifierFor("https://as.test/jwks", {
      resolveHost: async () => answer("93.184.216.34", "10.0.0.5"),
    });
    expect(await reasonOf(v.verify(await token()))).toBe("idp_unavailable");
    expect(calls).toHaveLength(0);
  });

  it("http:// to a public host is refused (a key set read in clear can be forged in transit)", async () => {
    const calls = fakeNet();
    const v = verifierFor("http://as.test/jwks", { plainHttpHosts: ["as.test"] });
    expect(await reasonOf(v.verify(await token()))).toBe("idp_unavailable");
    expect(calls).toHaveLength(0);
  });

  it("a 3xx is refused and the Location is never contacted", async () => {
    const calls = fakeNet([{ status: 307, location: "https://169.254.169.254/latest" }]);
    const v = verifierFor("https://as.test/jwks");
    expect(await reasonOf(v.verify(await token()))).toBe("idp_unavailable");
    expect(calls).toHaveLength(1);
  });

  it("a body over the size cap is refused", async () => {
    fakeNet([{ body: `{"keys":[],"pad":"${"x".repeat(300 * 1024)}"}` }]);
    const v = verifierFor("https://as.test/jwks");
    expect(await reasonOf(v.verify(await token()))).toBe("idp_unavailable");
  });
});

describe("opting out: loopback, and hosts listed in network.plainHttpHosts", () => {
  it("http://127.0.0.1 needs no entry and is connected to directly", async () => {
    const calls = fakeNet();
    const warn = vi.fn();
    const v = verifierFor("http://127.0.0.1:8080/jwks", { warn });
    expect((await v.verify(await token())).caller).toBe("alice");
    expect(calls[0]).toMatchObject({ scheme: "http", host: "127.0.0.1", port: 8080 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("a listed tailnet (100.64/10) host works over http, with the Host header kept, no warning", async () => {
    const calls = fakeNet();
    const warn = vi.fn();
    const v = verifierFor("http://keys.tailnet.test:9000/jwks", {
      plainHttpHosts: ["keys.tailnet.test"],
      resolveHost: async () => answer("100.64.0.5"),
      warn,
    });
    expect((await v.verify(await token())).caller).toBe("alice");
    expect(calls[0]).toMatchObject({ scheme: "http", host: "100.64.0.5", port: 9000 });
    expect(calls[0]?.headers.host).toBe("keys.tailnet.test:9000");
    expect(warn).not.toHaveBeenCalled();
  });

  it("rebinding on the opt-in path: one lookup, and the policy judges the SAME answer the socket uses", async () => {
    const calls = fakeNet();
    let lookups = 0;
    const v = verifierFor("http://keys.tailnet.test/jwks", {
      plainHttpHosts: ["keys.tailnet.test"],
      resolveHost: async () => answer(++lookups === 1 ? "100.64.0.5" : "169.254.169.254"),
    });
    expect((await v.verify(await token())).caller).toBe("alice");
    expect(lookups).toBe(1);
    expect(calls[0]?.host).toBe("100.64.0.5");
  });

  it("the same tailnet host UNLISTED is refused (the range counts only when listed)", async () => {
    const calls = fakeNet();
    const v = verifierFor("http://keys.tailnet.test/jwks", {
      resolveHost: async () => answer("100.64.0.5"),
    });
    expect(await reasonOf(v.verify(await token()))).toBe("idp_unavailable");
    expect(calls).toHaveLength(0);
  });

  it("an UNLISTED private host keeps working for one release, with a deprecation naming the host and the config", async () => {
    const calls = fakeNet();
    const warn = vi.fn();
    const v = verifierFor("http://keys.lan.test/jwks", {
      resolveHost: async () => answer("192.168.1.10"),
      warn,
    });
    expect((await v.verify(await token())).caller).toBe("alice");
    expect(calls[0]).toMatchObject({ scheme: "http", host: "192.168.1.10" });
    expect(warn).toHaveBeenCalledTimes(1);
    const text = String(warn.mock.calls[0]?.[0]);
    expect(text).toMatch(/DEPRECATED/);
    expect(text).toContain("keys.lan.test");
    expect(text).toContain("network.plainHttpHosts");
    expect(text).not.toContain("/jwks");
  });

  it("an https host on a private address is the same deprecation, and listing it silences it", async () => {
    fakeNet();
    const warn = vi.fn();
    const net = { resolveHost: async () => answer("10.1.2.3"), warn };
    expect(
      (await verifierFor("https://keys.lan.test/jwks", net).verify(await token())).caller,
    ).toBe("alice");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();
    const listed = verifierFor("https://keys.lan.test/jwks", {
      ...net,
      plainHttpHosts: ["keys.lan.test"],
    });
    expect((await listed.verify(await token())).caller).toBe("alice");
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["a metadata literal", "http://169.254.169.254/jwks", async () => answer("169.254.169.254")],
    [
      "an alibaba metadata literal",
      "http://100.100.100.200/jwks",
      async () => answer("100.100.100.200"),
    ],
    [
      "a name that resolves to metadata",
      "http://keys.test/jwks",
      async () => answer("169.254.169.254"),
    ],
    [
      "a name that resolves to loopback and metadata",
      "https://keys.test/jwks",
      async () => answer("127.0.0.1", "169.254.169.254"),
    ],
  ])(
    "%s is refused even when listed (listing trusts the name, not what DNS says)",
    async (_n, uri, resolveHost) => {
      const calls = fakeNet();
      const host = new URL(uri).hostname;
      const v = verifierFor(uri, { plainHttpHosts: [host], resolveHost });
      expect(await reasonOf(v.verify(await token()))).toBe("idp_unavailable");
      expect(calls).toHaveLength(0);
    },
  );

  it("buildJwtVerifier uses the process-wide network.plainHttpHosts and resolver", async () => {
    const calls = fakeNet();
    configureProviderPlainHttp(["keys.tailnet.test"]);
    setProviderResolveHostForTest(async () => answer("100.64.0.9"));
    const v = buildJwtVerifier({
      mode: "jwt",
      jwksUri: "http://keys.tailnet.test/jwks",
      audience: "x",
    } as never);
    expect(v).not.toBeNull();
    expect(await reasonOf((v as NonNullable<typeof v>).verify(await token()))).not.toBe(
      "idp_unavailable",
    );
    expect(calls[0]).toMatchObject({ scheme: "http", host: "100.64.0.9" });
  });
});

describe("describeJwksTarget: the one classification the startup line, doctor and server_health read", () => {
  const policy = (hosts: string[], ips: string[]) => ({
    plainHttpHosts: hosts,
    resolveHost: async () => answer(...ips),
  });
  it.each([
    ["https://a.test/j", [], ["93.184.216.34"], "public"],
    ["http://127.0.0.1/j", [], [], "loopback"],
    ["http://a.test/j", ["a.test"], ["100.64.0.5"], "private-listed"],
    ["http://a.test/j", [], ["172.16.0.5"], "private-unlisted"],
  ])("%s -> %s", async (uri, hosts, ips, mode) => {
    const { describeJwksTarget } = await import("../src/auth/jwks-network");
    const d = await describeJwksTarget(uri, policy(hosts, ips));
    expect(d).toMatchObject({ ok: true, mode });
  });
  it("refusals carry a reason that never contains the path or query", async () => {
    const { describeJwksTarget } = await import("../src/auth/jwks-network");
    const d = await describeJwksTarget(
      "http://a.test/jwks/SECRET?t=SECRET2",
      policy([], ["8.8.8.8"]),
    );
    expect(d.ok).toBe(false);
    expect(JSON.stringify(d)).not.toMatch(/SECRET/);
  });
});
