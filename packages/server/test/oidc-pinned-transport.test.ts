// OIDC discovery and JWKS fetches resolve the host, validate every answer is public, and then used
// to hand the NAME to the runtime fetch, which resolves it again: a record that flips between the
// two lookups (DNS rebinding) sent the request to a private or metadata address. The connection is
// now pinned to the address that was validated, TLS (SNI and certificate) stays on the hostname, and
// a redirect is reported, never followed.
//
// The socket layer is observed through node:https's `request` (the pinned transport's one seam),
// so no TLS server or certificate is needed.
import { EventEmitter } from "node:events";
import https from "node:https";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBoundedText } from "../src/auth/oidc-discovery";

interface Call {
  host: string;
  port: number;
  servername?: string;
  agent: unknown;
  headers: Record<string, string>;
  path: string;
}

/** A stand-in node:https request: records its options, answers per `plan`, in call order. */
function fakeHttps(plan: ("refused" | { status: number; body?: string; location?: string })[]) {
  const calls: Call[] = [];
  const spy = vi.spyOn(https, "request").mockImplementation(((opts: Call) => {
    calls.push(opts);
    const step = plan[Math.min(calls.length - 1, plan.length - 1)];
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    req.destroy = () => undefined;
    req.end = () => {
      queueMicrotask(() => {
        if (step === "refused") {
          req.emit("error", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
          return;
        }
        const res = Object.assign(Readable.from([Buffer.from(step?.body ?? "{}")]), {
          statusCode: step?.status ?? 200,
          statusMessage: "",
          rawHeaders:
            step?.location === undefined
              ? ["content-type", "application/json"]
              : ["location", step.location],
          headers: step?.location === undefined ? {} : { location: step.location },
        });
        req.emit("response", res);
      });
    };
    return req;
  }) as unknown as typeof https.request);
  return { calls, spy };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const opts = (resolveHost: (h: string) => Promise<string[]>) => ({
  maxBytes: 4096,
  what: "OIDC discovery",
  network: { resolveHost },
});

describe("OIDC fetches are pinned to the validated address", () => {
  it("rebinding: a public answer on the check and a metadata answer on the next lookup still connects to the public one", async () => {
    let lookups = 0;
    const { calls } = fakeHttps([{ status: 200, body: '{"ok":1}' }]);
    // The runtime fetch would be handed the NAME; if it were, this stub is where a second lookup
    // would land. The pinned transport must never ask again.
    const resolveHost = async () => (++lookups === 1 ? ["93.184.216.34"] : ["169.254.169.254"]);
    const text = await fetchBoundedText(
      "https://idp.test/.well-known/openid-configuration",
      opts(resolveHost),
    );
    expect(text).toBe('{"ok":1}');
    expect(lookups).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.host).toBe("93.184.216.34");
    expect(calls[0]?.port).toBe(443);
    expect(calls[0]?.servername).toBe("idp.test");
    expect(calls[0]?.headers.host).toBe("idp.test");
    expect(calls[0]?.path).toBe("/.well-known/openid-configuration");
    expect(calls[0]?.agent).toBe(false);
  });

  it("the global fetch is never handed the name when the host is checked", async () => {
    const globalFetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", globalFetch);
    fakeHttps([{ status: 200 }]);
    await fetchBoundedText("https://idp.test/jwks", opts(async () => ["93.184.216.34"]));
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("a non-default port is kept, an IP-literal host sets no SNI name", async () => {
    const { calls } = fakeHttps([{ status: 200 }]);
    await fetchBoundedText("https://idp.test:8443/jwks", opts(async () => ["93.184.216.34"]));
    await fetchBoundedText("https://93.184.216.34/jwks", opts(async () => []));
    expect(calls[0]?.port).toBe(8443);
    expect(calls[0]?.headers.host).toBe("idp.test:8443");
    expect(calls[1]?.host).toBe("93.184.216.34");
    expect(calls[1]?.servername).toBeUndefined();
  });

  it("tries the next validated address when the first refuses the connection, and never an unvalidated one", async () => {
    const resolveHost = async () => ["2606:4700:4700::1111", "93.184.216.34"];
    const { calls } = fakeHttps(["refused", { status: 200, body: "{}" }]);
    await fetchBoundedText("https://idp.test/jwks", opts(resolveHost));
    expect(calls.map((c) => c.host)).toEqual(["2606:4700:4700::1111", "93.184.216.34"]);
  });

  it("when every validated address refuses, it fails with the last error", async () => {
    fakeHttps(["refused"]);
    await expect(
      fetchBoundedText("https://idp.test/jwks", opts(async () => ["93.184.216.34"])),
    ).rejects.toThrow(/could not be fetched.*ECONNREFUSED/);
  });

  it("a 3xx is reported as a redirect and the Location is never contacted", async () => {
    const { calls } = fakeHttps([{ status: 307, location: "https://169.254.169.254/latest" }]);
    await expect(
      fetchBoundedText("https://idp.test/jwks", opts(async () => ["93.184.216.34"])),
    ).rejects.toThrow(/307 redirect; redirects are not followed/);
    expect(calls).toHaveLength(1);
  });

  it("a private address in the answer is refused before any socket exists", async () => {
    const { calls } = fakeHttps([{ status: 200 }]);
    await expect(
      fetchBoundedText(
        "https://idp.test/jwks",
        opts(async () => ["93.184.216.34", "10.0.0.5"]),
      ),
    ).rejects.toThrow(/not a public address/);
    expect(calls).toHaveLength(0);
  });

  it("allowPrivateNetwork (a self-hosted IdP) keeps the ordinary fetch, which is where a proxy applies", async () => {
    const globalFetch = vi.fn(async () => new Response('{"a":1}'));
    vi.stubGlobal("fetch", globalFetch);
    const { calls } = fakeHttps([{ status: 200 }]);
    const text = await fetchBoundedText("https://idp.lan/jwks", {
      maxBytes: 4096,
      what: "OIDC JWKS",
      network: { allowPrivateNetwork: true },
    });
    expect(text).toBe('{"a":1}');
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it("an injected fetch (the test seam) is used as given", async () => {
    const injected = vi.fn(async () => new Response("{}"));
    const { calls } = fakeHttps([{ status: 200 }]);
    await fetchBoundedText("https://idp.test/jwks", {
      ...opts(async () => ["93.184.216.34"]),
      fetch: injected as unknown as typeof fetch,
    });
    expect(injected).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });
});
