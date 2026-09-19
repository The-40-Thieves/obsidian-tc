// THE-1078: the TypeSafe Jev fetch client (gateway/typesafe.ts) — the wire contract, retry/timeout
// shape, and the shape-change-is-a-typed-error contract. Fetch is always mocked (vi.stubGlobal);
// no network in this file.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTypesafeClient, TypesafeError } from "../src/gateway/typesafe";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// Captured with the exact command this ticket specifies, against the real endpoint, with the key
// read from ~/.config/typesafe/env and never written down here:
//   curl -s https://api.typesafe.ai/v1/systemone -H "Authorization: Bearer $KEY" \
//     -H 'Content-Type: application/json' -d '{"state":{"source":"The gateway listens on port
//     4001.","response":"It listens on 4001."},"model":"jev-1.13.0","questions":{"uses_source":
//     {"type":"noul","instructions":"Does the response use information from the
//     source?","criteria":{"true":"yes","false":"no"}}}}'
// No key, no vault text — a synthetic source/response pair chosen for the capture. The question
// id here ("uses_source") differs from this client's own request id, deliberately: the fixture
// proves the client unwraps whichever single key `answers` carries back, not a hardcoded name.
const REAL_CONTRACT_FIXTURE = {
  model: "jev-1.13.0",
  answers: { uses_source: { type: "noul", noul: 0.98 } },
  usage: { input_tokens: 326, output_tokens: 21 },
};

describe("typesafe client — contract fixture", () => {
  it("parses a real captured /v1/systemone response", async () => {
    const fetchFn = (async () => jsonResponse(REAL_CONTRACT_FIXTURE)) as unknown as typeof fetch;
    const client = createTypesafeClient({ baseUrl: "http://ts", apiKey: "k", fetchFn });
    const r = await client.noul({
      state: { source: "s", response: "r" },
      model: "jev-1.13.0",
      instructions: "does it use it?",
      criteria: { true: "yes", false: "no" },
    });
    expect(r).toEqual({
      noul: 0.98,
      model: "jev-1.13.0",
      usage: { inputTokens: 326, outputTokens: 21 },
    });
  });

  it("a shape change (missing answers.<id>.noul) is a TYPED error, not undefined", async () => {
    const malformed = { model: "jev-1.13.0", answers: { uses_source: { type: "noul" } } };
    const fetchFn = (async () => jsonResponse(malformed)) as unknown as typeof fetch;
    const client = createTypesafeClient({ baseUrl: "http://ts", apiKey: "k", fetchFn });
    const call = client.noul({
      state: {},
      model: "jev-1.13.0",
      instructions: "?",
      criteria: { true: "y", false: "n" },
    });
    await expect(call).rejects.toBeInstanceOf(TypesafeError);
    await expect(call).rejects.toMatchObject({ message: expect.stringContaining("answers") });
  });

  it("an entirely absent answers object is also a typed error", async () => {
    const fetchFn = (async () => jsonResponse({ model: "jev-1.13.0" })) as unknown as typeof fetch;
    const client = createTypesafeClient({ baseUrl: "http://ts", apiKey: "k", fetchFn });
    await expect(
      client.noul({
        state: {},
        model: "jev-1.13.0",
        instructions: "?",
        criteria: { true: "y", false: "n" },
      }),
    ).rejects.toBeInstanceOf(TypesafeError);
  });
});

// A malformed 2xx means the judge ANSWERED — just unusably. Every case here must throw a
// TypesafeError with `kind: "shape"`, never `undefined`/an out-of-range number threaded through
// as a score, and never conflated with a transport failure (see citation-judge.test.ts for the
// adapter-level `{kind: "unparseable"}` mapping this feeds).
describe("typesafe client — shape validation (kind: 'shape')", () => {
  function clientFor(body: unknown) {
    const fetchFn = (async () => jsonResponse(body)) as unknown as typeof fetch;
    return createTypesafeClient({ baseUrl: "http://ts", apiKey: "k", fetchFn });
  }
  const call = (client: ReturnType<typeof clientFor>) =>
    client.noul({ state: {}, model: "m", instructions: "?", criteria: { true: "y", false: "n" } });

  it("rejects noul > 1 (e.g. 7) — never silently accepted as a score", async () => {
    const client = clientFor({ model: "m", answers: { q: { type: "noul", noul: 7 } } });
    const p = call(client);
    await expect(p).rejects.toBeInstanceOf(TypesafeError);
    await expect(p).rejects.toMatchObject({ kind: "shape" });
  });

  it("rejects noul < 0 (e.g. -0.1)", async () => {
    const client = clientFor({ model: "m", answers: { q: { type: "noul", noul: -0.1 } } });
    const p = call(client);
    await expect(p).rejects.toBeInstanceOf(TypesafeError);
    await expect(p).rejects.toMatchObject({ kind: "shape" });
  });

  it("rejects TWO answers — never resolved by 'take the first key'", async () => {
    const client = clientFor({
      model: "m",
      answers: {
        q1: { type: "noul", noul: 0.9 },
        q2: { type: "noul", noul: 0.1 },
      },
    });
    const p = call(client);
    await expect(p).rejects.toBeInstanceOf(TypesafeError);
    await expect(p).rejects.toMatchObject({ kind: "shape" });
  });

  it("rejects ZERO answers (an empty answers object, distinct from an absent one)", async () => {
    const client = clientFor({ model: "m", answers: {} });
    const p = call(client);
    await expect(p).rejects.toBeInstanceOf(TypesafeError);
    await expect(p).rejects.toMatchObject({ kind: "shape" });
  });

  it('rejects the wrong answer "type"', async () => {
    const client = clientFor({ model: "m", answers: { q: { type: "boolean", noul: 0.5 } } });
    const p = call(client);
    await expect(p).rejects.toBeInstanceOf(TypesafeError);
    await expect(p).rejects.toMatchObject({ kind: "shape" });
  });

  it("rejects a 2xx whose JSON root is null — kind: 'shape', not a stray TypeError (transport)", async () => {
    const client = clientFor(null);
    await expect(call(client)).rejects.toMatchObject({ kind: "shape" });
  });

  it("rejects a 2xx whose JSON root is an array — kind: 'shape'", async () => {
    const client = clientFor([{ model: "m", answers: { q: { type: "noul", noul: 0.9 } } }]);
    await expect(call(client)).rejects.toMatchObject({ kind: "shape" });
  });

  it("rejects `answers` given as a one-element ARRAY — Object.keys([x]) is ['0'], not one answer", async () => {
    const client = clientFor({ model: "m", answers: [{ type: "noul", noul: 0.9 }] });
    await expect(call(client)).rejects.toMatchObject({ kind: "shape" });
  });

  it("rejects a sole answer that is null or not an object — kind: 'shape'", async () => {
    await expect(call(clientFor({ model: "m", answers: { q: null } }))).rejects.toMatchObject({
      kind: "shape",
    });
    await expect(call(clientFor({ model: "m", answers: { q: 0.9 } }))).rejects.toMatchObject({
      kind: "shape",
    });
  });

  it("the missing-noul and absent-answers cases (above) are also kind: 'shape'", async () => {
    const missingNoul = clientFor({ model: "m", answers: { q: { type: "noul" } } });
    await expect(call(missingNoul)).rejects.toMatchObject({ kind: "shape" });
    const noAnswers = clientFor({ model: "m" });
    await expect(call(noAnswers)).rejects.toMatchObject({ kind: "shape" });
  });

  it("an HTTP failure is kind: 'http', a network throw is kind: 'network', a timeout is kind: 'timeout'", async () => {
    const http401 = createTypesafeClient({
      baseUrl: "http://ts",
      apiKey: "k",
      maxAttempts: 1,
      fetchFn: (async () => jsonResponse({}, 401)) as unknown as typeof fetch,
    });
    const httpErr = await call(http401).catch((e) => e);
    expect(httpErr).toBeInstanceOf(TypesafeError);
    expect(httpErr.kind).toBe("http");

    const netClient = createTypesafeClient({
      baseUrl: "http://ts",
      apiKey: "k",
      maxAttempts: 1,
      fetchFn: (async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });
    const netErr = await call(netClient).catch((e) => e);
    expect(netErr).toBeInstanceOf(TypesafeError);
    expect(netErr.kind).toBe("network");

    const timeoutClient = createTypesafeClient({
      baseUrl: "http://ts",
      apiKey: "k",
      maxAttempts: 1,
      timeoutMs: 5,
      fetchFn: (async (_url: any, init: any) => {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        });
      }) as unknown as typeof fetch,
    });
    const timeoutErr = await call(timeoutClient).catch((e) => e);
    expect(timeoutErr).toBeInstanceOf(TypesafeError);
    expect(timeoutErr.kind).toBe("timeout");
  });
});

describe("typesafe client — wire shape", () => {
  it("POSTs {baseUrl}/v1/systemone with Bearer auth and exactly one noul question", async () => {
    let seenUrl = "";
    let seenBody: any;
    let seenHeaders: Record<string, string> = {};
    const fetchFn = (async (url: any, init: any) => {
      seenUrl = String(url);
      seenBody = JSON.parse(init.body);
      seenHeaders = init.headers;
      return jsonResponse({ model: "jev-1.13.0", answers: { q: { type: "noul", noul: 0.5 } } });
    }) as unknown as typeof fetch;
    const client = createTypesafeClient({ baseUrl: "http://ts", apiKey: "secret-key", fetchFn });
    await client.noul({
      state: { a: 1 },
      model: "jev-1.13.0",
      instructions: "instr",
      criteria: { true: "t", false: "f" },
    });
    expect(seenUrl).toBe("http://ts/v1/systemone");
    expect(seenBody.state).toEqual({ a: 1 });
    expect(seenBody.model).toBe("jev-1.13.0");
    expect(Object.keys(seenBody.questions)).toHaveLength(1);
    const q = Object.values(seenBody.questions)[0] as any;
    expect(q).toEqual({ type: "noul", instructions: "instr", criteria: { true: "t", false: "f" } });
    expect(seenHeaders.authorization).toBe("Bearer secret-key");
    expect(seenHeaders["content-type"]).toBe("application/json");
    expect(seenHeaders.accept).toBe("application/json");
    expect(seenHeaders["user-agent"]).toMatch(/^obsidian-tc\//);
    // Attempt 1 carries NO retry-count header at all.
    expect(seenHeaders["x-typesafe-retry-count"]).toBeUndefined();
  });

  it("defaults baseUrl to https://api.typesafe.ai and strips a trailing slash", async () => {
    let seenUrl = "";
    const fetchFn = (async (url: any) => {
      seenUrl = String(url);
      return jsonResponse({ model: "m", answers: { q: { type: "noul", noul: 1 } } });
    }) as unknown as typeof fetch;
    const client = createTypesafeClient({ baseUrl: "https://api.typesafe.ai/", fetchFn });
    await client.noul({
      state: {},
      model: "m",
      instructions: "i",
      criteria: { true: "t", false: "f" },
    });
    expect(seenUrl).toBe("https://api.typesafe.ai/v1/systemone");
  });

  it("a NETWORK error whose own message carries the request headers never leaks the key", async () => {
    // A fetch wrapper / instrumentation layer that throws with its headers in the message is the
    // realistic leak path (review round 2). Only the error's name and code may reach the caller.
    const fetchFn = (async () => {
      const e = new Error("request failed: headers={authorization: Bearer super-secret-key-xyz}");
      (e as Error & { code?: string }).code = "ECONNREFUSED";
      throw e;
    }) as unknown as typeof fetch;
    const client = createTypesafeClient({
      baseUrl: "http://ts",
      apiKey: "super-secret-key-xyz",
      fetchFn,
      maxAttempts: 1,
    });
    const err = await client
      .noul({ state: {}, model: "m", instructions: "i", criteria: { true: "t", false: "f" } })
      .catch((e) => e);
    expect(err).toBeInstanceOf(TypesafeError);
    expect(err.kind).toBe("network");
    expect(String(err.message)).not.toContain("super-secret-key-xyz");
    expect(String(err.message)).toContain("ECONNREFUSED");
    expect(JSON.stringify(err)).not.toContain("super-secret-key-xyz");
  });

  it("never logs or leaks the key into a thrown error's message", async () => {
    const fetchFn = (async () => jsonResponse({}, 401)) as unknown as typeof fetch;
    const client = createTypesafeClient({
      baseUrl: "http://ts",
      apiKey: "super-secret-key-xyz",
      fetchFn,
      maxAttempts: 1,
    });
    const err = await client
      .noul({ state: {}, model: "m", instructions: "i", criteria: { true: "t", false: "f" } })
      .catch((e) => e);
    expect(String(err.message)).not.toContain("super-secret-key-xyz");
  });
});

describe("typesafe client — retry", () => {
  it("retries a 429 honoring retry-after-ms, then succeeds", async () => {
    let calls = 0;
    const delays: number[] = [];
    const fetchFn = (async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({}, 429, { "retry-after-ms": "10" });
      return jsonResponse({ model: "m", answers: { q: { type: "noul", noul: 0.7 } } });
    }) as unknown as typeof fetch;
    const client = createTypesafeClient({
      baseUrl: "http://ts",
      fetchFn,
      maxAttempts: 2,
      sleepFn: async (ms) => {
        delays.push(ms);
      },
    });
    const r = await client.noul({
      state: {},
      model: "m",
      instructions: "i",
      criteria: { true: "t", false: "f" },
    });
    expect(r.noul).toBe(0.7);
    expect(calls).toBe(2);
    expect(delays).toEqual([10]);
  });

  it("retries honoring Retry-After as an HTTP-date", async () => {
    let calls = 0;
    const delays: number[] = [];
    const retryAt = new Date(Date.now() + 5000).toUTCString();
    const fetchFn = (async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({}, 429, { "retry-after": retryAt });
      return jsonResponse({ model: "m", answers: { q: { type: "noul", noul: 0.2 } } });
    }) as unknown as typeof fetch;
    const client = createTypesafeClient({
      baseUrl: "http://ts",
      fetchFn,
      maxAttempts: 2,
      sleepFn: async (ms) => {
        delays.push(ms);
      },
    });
    const r = await client.noul({
      state: {},
      model: "m",
      instructions: "i",
      criteria: { true: "t", false: "f" },
    });
    expect(r.noul).toBe(0.2);
    expect(calls).toBe(2);
    expect(delays).toHaveLength(1);
    // An HTTP-date resolves to the second, and there is real clock skew between constructing the
    // header above and the client evaluating it — assert a window around 5000ms, not an exact ms.
    expect(delays[0]).toBeGreaterThan(3000);
    expect(delays[0]).toBeLessThanOrEqual(5000);
  });

  it("caps a Retry-After larger than 60s at the 60s ceiling", async () => {
    let calls = 0;
    const delays: number[] = [];
    const fetchFn = (async () => {
      calls += 1;
      // 120 seconds — well past the 60s cap.
      if (calls === 1) return jsonResponse({}, 429, { "retry-after": "120" });
      return jsonResponse({ model: "m", answers: { q: { type: "noul", noul: 0.2 } } });
    }) as unknown as typeof fetch;
    const client = createTypesafeClient({
      baseUrl: "http://ts",
      fetchFn,
      maxAttempts: 2,
      sleepFn: async (ms) => {
        delays.push(ms);
      },
    });
    await client.noul({
      state: {},
      model: "m",
      instructions: "i",
      criteria: { true: "t", false: "f" },
    });
    expect(delays).toEqual([60_000]);
  });

  it("prefers retry-after-ms over Retry-After when both are present", async () => {
    let calls = 0;
    const delays: number[] = [];
    const fetchFn = (async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({}, 429, { "retry-after-ms": "25", "retry-after": "120" });
      }
      return jsonResponse({ model: "m", answers: { q: { type: "noul", noul: 0.2 } } });
    }) as unknown as typeof fetch;
    const client = createTypesafeClient({
      baseUrl: "http://ts",
      fetchFn,
      maxAttempts: 2,
      sleepFn: async (ms) => {
        delays.push(ms);
      },
    });
    await client.noul({
      state: {},
      model: "m",
      instructions: "i",
      criteria: { true: "t", false: "f" },
    });
    // 25ms (retry-after-ms), never the 120s Retry-After also present on the same response.
    expect(delays).toEqual([25]);
  });

  it("retries a 529, and a generic 5xx, up to maxAttempts", async () => {
    for (const status of [529, 503]) {
      let calls = 0;
      const fetchFn = (async () => {
        calls += 1;
        return calls < 3
          ? jsonResponse({}, status)
          : jsonResponse({ model: "m", answers: { q: { type: "noul", noul: 0.3 } } });
      }) as unknown as typeof fetch;
      const client = createTypesafeClient({
        baseUrl: "http://ts",
        fetchFn,
        maxAttempts: 3,
        retryBaseDelayMs: 1,
        retryJitter: 0,
        sleepFn: async () => {},
      });
      const r = await client.noul({
        state: {},
        model: "m",
        instructions: "i",
        criteria: { true: "t", false: "f" },
      });
      expect(r.noul).toBe(0.3);
      expect(calls).toBe(3);
    }
  });

  it("does NOT retry 401 or 422 — a wrong request, not a transient failure", async () => {
    for (const status of [401, 422]) {
      let calls = 0;
      const fetchFn = (async () => {
        calls += 1;
        return jsonResponse({}, status);
      }) as unknown as typeof fetch;
      const client = createTypesafeClient({ baseUrl: "http://ts", fetchFn, maxAttempts: 3 });
      const err = await client
        .noul({ state: {}, model: "m", instructions: "i", criteria: { true: "t", false: "f" } })
        .catch((e) => e);
      expect(err).toBeInstanceOf(TypesafeError);
      expect(err.status).toBe(status);
      expect(calls).toBe(1);
    }
  });

  it(
    "retries a per-attempt timeout with a FRESH AbortController — a reused, already-fired " +
      "signal would abort the retry instantly",
    async () => {
      let calls = 0;
      const fetchFn = (async (_url: any, init: any) => {
        calls += 1;
        if (calls === 1) {
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => {
              const e = new Error("aborted");
              e.name = "AbortError";
              reject(e);
            });
          });
        }
        expect(init.signal.aborted).toBe(false);
        return jsonResponse({ model: "m", answers: { q: { type: "noul", noul: 0.4 } } });
      }) as unknown as typeof fetch;
      const client = createTypesafeClient({
        baseUrl: "http://ts",
        fetchFn,
        timeoutMs: 5,
        maxAttempts: 2,
        retryBaseDelayMs: 1,
        sleepFn: async () => {},
      });
      const r = await client.noul({
        state: {},
        model: "m",
        instructions: "i",
        criteria: { true: "t", false: "f" },
      });
      expect(r.noul).toBe(0.4);
      expect(calls).toBe(2);
    },
  );

  it("sends X-TypeSafe-Retry-Count only on retried attempts", async () => {
    let calls = 0;
    const counts: Array<string | undefined> = [];
    const fetchFn = (async (_url: any, init: any) => {
      calls += 1;
      counts.push(init.headers["x-typesafe-retry-count"]);
      if (calls < 3) return jsonResponse({}, 503);
      return jsonResponse({ model: "m", answers: { q: { type: "noul", noul: 0.1 } } });
    }) as unknown as typeof fetch;
    const client = createTypesafeClient({
      baseUrl: "http://ts",
      fetchFn,
      maxAttempts: 3,
      retryBaseDelayMs: 1,
      sleepFn: async () => {},
    });
    await client.noul({
      state: {},
      model: "m",
      instructions: "i",
      criteria: { true: "t", false: "f" },
    });
    expect(counts).toEqual([undefined, "1", "2"]);
  });

  it("gives up after maxAttempts and throws the typed error", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return jsonResponse({}, 529);
    }) as unknown as typeof fetch;
    const client = createTypesafeClient({
      baseUrl: "http://ts",
      fetchFn,
      maxAttempts: 3,
      retryBaseDelayMs: 1,
      sleepFn: async () => {},
    });
    const err = await client
      .noul({ state: {}, model: "m", instructions: "i", criteria: { true: "t", false: "f" } })
      .catch((e) => e);
    expect(err).toBeInstanceOf(TypesafeError);
    expect(err.status).toBe(529);
    expect(calls).toBe(3);
  });
});
