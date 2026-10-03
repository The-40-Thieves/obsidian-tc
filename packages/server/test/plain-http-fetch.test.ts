// The plain-http outbound policy for the TypeSafe judge client: a non-loopback http:// baseUrl is
// sent only when its host is listed in plainHttpHosts (or, deprecated, named by allowPlainHttp for
// its own baseUrl) AND every address it resolves to is private, with the connection pinned to the
// address that was checked. Run against a stub resolver and a local server so no real DNS or
// internet is touched; globalThis.fetch is a tripwire wherever a plain-http request must never
// reach it.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPlainHttpPolicyFetch,
  PlainHttpRefusedError,
  type ResolveHost,
  resolvePlainHttpTarget,
} from "../src/gateway/plain-http";
import { buildTypesafeJudgeClient } from "../src/gateway/typesafe-judge-client";

const NAMES = { label: "wikiJudge", field: "wikiJudge" };
const OK_BODY = JSON.stringify({
  model: "jev-1.13.0",
  answers: { q: { type: "noul", noul: 0.9 } },
});
const NOUL = {
  state: { a: 1 },
  model: "jev-1.13.0",
  instructions: "q?",
  criteria: { true: "yes", false: "no" },
};

interface Seen {
  host: string | undefined;
  url: string | undefined;
  auth: string | undefined;
  body: string;
}

let server: http.Server;
let port: number;
let seen: Seen[];
let respond: (res: http.ServerResponse) => void;

beforeEach(async () => {
  seen = [];
  respond = (res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(OK_BODY);
  };
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      seen.push({
        host: req.headers.host,
        url: req.url,
        auth: req.headers.authorization,
        body,
      });
      respond(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await new Promise<void>((r) => server.close(() => r()));
});

function cfg(extra: Record<string, unknown>) {
  return { model: "jev-1.13.0", threshold: 0.5, apiKey: "sk-secret-key", ...extra };
}

/** globalThis.fetch tripwire: counts calls and answers like TypeSafe would. */
function stubGlobalFetch() {
  const fn = vi.fn(async () => new Response(OK_BODY, { status: 200 }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("plain http outbound policy (connect time)", () => {
  it("allowPlainHttp: true does not waive the private-address check: a public-resolving host is refused and nothing is sent", async () => {
    const globalFetch = stubGlobalFetch();
    const requestSpy = vi.spyOn(http, "request");
    const resolveHost = vi.fn<ResolveHost>(async () => [{ address: "93.184.216.34", family: 4 }]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = buildTypesafeJudgeClient(
      cfg({ baseUrl: "http://example.com", allowPlainHttp: true }),
      NAMES,
      undefined,
      { resolveHost },
    );
    await expect(client.noul(NOUL)).rejects.toThrow(/refus|not a private/i);
    expect(resolveHost).toHaveBeenCalledTimes(1);
    expect(requestSpy).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });

  it("a refusal is not retried and its message never carries the key", async () => {
    const resolveHost = vi.fn<ResolveHost>(async () => [{ address: "93.184.216.34", family: 4 }]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = buildTypesafeJudgeClient(
      cfg({ baseUrl: "http://example.com", plainHttpHosts: ["example.com"] }),
      NAMES,
      undefined,
      { resolveHost },
    );
    const err = await client.noul(NOUL).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("sk-secret-key");
    expect((err as Error).message).toMatch(/example\.com/);
    expect(resolveHost).toHaveBeenCalledTimes(1);
  });

  it("a host not in plainHttpHosts is refused before any lookup", async () => {
    const resolveHost = vi.fn<ResolveHost>(async () => [{ address: "172.18.0.5", family: 4 }]);
    expect(() =>
      buildTypesafeJudgeClient(
        cfg({ baseUrl: "http://example.com", plainHttpHosts: ["litellm"] }),
        NAMES,
        undefined,
        { resolveHost },
      ),
    ).toThrow(/plainHttpHosts/);
    // The same refusal holds one layer down, where a client is built without the builder.
    const f = createPlainHttpPolicyFetch({ plainHttpHosts: ["litellm"], resolveHost });
    await expect(f("http://example.com/x")).rejects.toBeInstanceOf(PlainHttpRefusedError);
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it("a listed host resolving to 172.18.0.5 (Cave's litellm) is accepted and pinned to that address", async () => {
    const resolveHost: ResolveHost = async () => [{ address: "172.18.0.5", family: 4 }];
    const t = await resolvePlainHttpTarget(new URL("http://litellm:4000/typesafe"), {
      plainHttpHosts: ["litellm"],
      resolveHost,
    });
    expect(t).toEqual({ address: "172.18.0.5", family: 4 });
  });

  it("a LISTED host that resolves to the cloud metadata address is refused", async () => {
    for (const address of ["169.254.169.254", "fe80::1"]) {
      await expect(
        resolvePlainHttpTarget(new URL("http://litellm:4000/"), {
          plainHttpHosts: ["litellm"],
          resolveHost: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
        }),
      ).rejects.toBeInstanceOf(PlainHttpRefusedError);
    }
  });

  it("every resolved address must be private: one public answer among private ones refuses the host", async () => {
    const resolveHost: ResolveHost = async () => [
      { address: "172.18.0.5", family: 4 },
      { address: "8.8.8.8", family: 4 },
    ];
    await expect(
      resolvePlainHttpTarget(new URL("http://litellm:4000/"), {
        plainHttpHosts: ["litellm"],
        resolveHost,
      }),
    ).rejects.toBeInstanceOf(PlainHttpRefusedError);
    await expect(
      resolvePlainHttpTarget(new URL("http://litellm:4000/"), {
        plainHttpHosts: ["litellm"],
        resolveHost: async () => [],
      }),
    ).rejects.toBeInstanceOf(PlainHttpRefusedError);
  });

  it("sends to the pinned address with the original Host header: a second, public DNS answer cannot swap in", async () => {
    const globalFetch = stubGlobalFetch();
    let calls = 0;
    const resolveHost = vi.fn<ResolveHost>(async () => {
      calls++;
      return calls === 1
        ? [{ address: "127.0.0.1", family: 4 }]
        : [{ address: "8.8.8.8", family: 4 }];
    });
    const { client } = buildTypesafeJudgeClient(
      cfg({ baseUrl: `http://litellm:${port}/typesafe`, plainHttpHosts: ["LiteLLM"] }),
      NAMES,
      undefined,
      { resolveHost },
    );
    const r = await client.noul(NOUL);
    expect(r.noul).toBe(0.9);
    expect(calls).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.host).toBe(`litellm:${port}`);
    expect(seen[0]?.url).toBe("/typesafe/v1/systemone");
    expect(seen[0]?.auth).toBe("Bearer sk-secret-key");
    expect(JSON.parse(seen[0]?.body ?? "{}").model).toBe("jev-1.13.0");
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it.each([
    "http://[::ffff:8.8.8.8]/",
    "http://0x08080808/",
    "http://134744072/",
    "http://010.0.0.1/",
    "http://169.254.169.254/",
    "http://[::ffff:169.254.169.254]/",
    "http://[fe80::1]/",
  ])(
    "%s is refused even with the legacy flag, with nothing sent and no DNS needed",
    async (baseUrl) => {
      const globalFetch = stubGlobalFetch();
      const requestSpy = vi.spyOn(http, "request");
      const resolveHost = vi.fn<ResolveHost>(async () => {
        throw new Error("an IP literal must not be resolved");
      });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { client } = buildTypesafeJudgeClient(
        cfg({ baseUrl, allowPlainHttp: true }),
        NAMES,
        undefined,
        { resolveHost },
      );
      await expect(client.noul(NOUL)).rejects.toThrow(/refus|not a private/i);
      expect(requestSpy).not.toHaveBeenCalled();
      expect(globalFetch).not.toHaveBeenCalled();
    },
  );

  it("an IPv4-mapped private literal is accepted only through the same path", async () => {
    const t = await resolvePlainHttpTarget(new URL("http://[::ffff:10.0.0.1]:4000/"), {
      plainHttpHosts: ["[::ffff:a00:1]"],
      resolveHost: async () => {
        throw new Error("no DNS for a literal");
      },
    });
    expect(t.address).toBe("::ffff:a00:1");
  });

  it("the deprecated flag warns that it is deprecated and names its replacement", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    buildTypesafeJudgeClient(
      cfg({ baseUrl: "http://litellm:4000/typesafe", allowPlainHttp: true }),
      NAMES,
      stubGlobalFetch() as unknown as typeof fetch,
    );
    const text = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toMatch(/allowPlainHttp is deprecated/);
    expect(text).toMatch(/plainHttpHosts/);
    expect(text).toMatch(/next major/);
  });

  it.each([301, 302, 303, 307, 308])(
    "refuses a %i redirect from a listed private host to a public one: nothing is sent to the second host and the error says so",
    async (status) => {
      respond = (res) => {
        res.writeHead(status, { location: "http://example.com/" });
        res.end();
      };
      const globalFetch = stubGlobalFetch();
      const resolved: string[] = [];
      const resolveHost: ResolveHost = async (h) => {
        resolved.push(h);
        return h === "litellm"
          ? [{ address: "127.0.0.1", family: 4 }]
          : [{ address: "93.184.216.34", family: 4 }];
      };
      const { client } = buildTypesafeJudgeClient(
        cfg({ baseUrl: `http://litellm:${port}`, plainHttpHosts: ["litellm"] }),
        NAMES,
        undefined,
        { resolveHost },
      );
      const err = await client.noul(NOUL).catch((e: Error) => e);
      expect((err as Error).message).toMatch(/redirect/i);
      expect((err as Error).message).toMatch(/litellm/);
      expect((err as Error).message).not.toContain("sk-secret-key");
      // One request reached the listed host (a redirect is not retried); the Location target was
      // never resolved, connected to or handed to the global fetch.
      expect(seen).toHaveLength(1);
      expect(resolved).toEqual(["litellm"]);
      expect(globalFetch).not.toHaveBeenCalled();
    },
  );

  it("an aborted request is torn down and never sent", async () => {
    const f = createPlainHttpPolicyFetch({
      plainHttpHosts: ["litellm"],
      resolveHost: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      f(`http://litellm:${port}/x`, { method: "POST", body: "{}", signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toHaveLength(0);
  });
});

describe("existing paths are unchanged", () => {
  it("https goes through the ordinary fetch, no resolver, no policy", async () => {
    const globalFetch = stubGlobalFetch();
    const resolveHost = vi.fn<ResolveHost>(async () => []);
    const { client } = buildTypesafeJudgeClient(cfg({}), NAMES, undefined, { resolveHost });
    await client.noul(NOUL);
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(String((globalFetch.mock.calls[0] as unknown[])[0])).toBe(
      "https://api.typesafe.ai/v1/systemone",
    );
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it("loopback http keeps working with no flag and no list", async () => {
    const resolveHost = vi.fn<ResolveHost>(async () => []);
    const { client } = buildTypesafeJudgeClient(
      cfg({ baseUrl: `http://127.0.0.1:${port}` }),
      NAMES,
      undefined,
      { resolveHost },
    );
    expect((await client.noul(NOUL)).noul).toBe(0.9);
    expect(seen).toHaveLength(1);
    expect(resolveHost).not.toHaveBeenCalled();
  });

  it("an injected fetchFn is still the transport seam", async () => {
    const injected = vi.fn(async () => new Response(OK_BODY, { status: 200 }));
    const { client } = buildTypesafeJudgeClient(
      cfg({ baseUrl: "http://litellm:4000", plainHttpHosts: ["litellm"] }),
      NAMES,
      injected as unknown as typeof fetch,
    );
    await client.noul(NOUL);
    expect(injected).toHaveBeenCalledTimes(1);
  });
});
