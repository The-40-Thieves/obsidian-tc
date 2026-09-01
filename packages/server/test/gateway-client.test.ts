import { describe, expect, it } from "vitest";
import { createGatewayClient, resolveGatewayUrl } from "../src/gateway/client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("gateway client", () => {
  it("extract/synthesize/judge POST /chat/completions with the role as the model alias", async () => {
    const calls: Array<{ url: string; body: any; auth?: string }> = [];
    const fetchFn = (async (url: any, init: any) => {
      calls.push({
        url: String(url),
        body: JSON.parse(init.body as string),
        auth: init.headers?.authorization,
      });
      return jsonResponse({
        model: "anthropic/claude-x",
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      });
    }) as unknown as typeof fetch;

    const client = createGatewayClient({ baseUrl: "http://gw", token: "k", fetchFn });
    const r = await client.extract({ messages: [{ role: "user", content: "hi" }] });
    expect(r.text).toBe("ok");
    // the gateway's resolved model is surfaced for attestation, not the role alias
    expect(r.model).toBe("anthropic/claude-x");
    expect(r.finishReason).toBe("stop");

    await client.synthesize({ messages: [{ role: "user", content: "s" }] });
    await client.judge({ messages: [{ role: "user", content: "j" }] });

    expect(calls.map((c) => c.url)).toEqual([
      "http://gw/chat/completions",
      "http://gw/chat/completions",
      "http://gw/chat/completions",
    ]);
    expect(calls.map((c) => c.body.model)).toEqual(["extract", "synthesize", "judge"]);
    expect(calls[0]?.auth).toBe("Bearer k");
  });

  it("models override maps a role to a concrete gateway model", async () => {
    let sentModel = "";
    const fetchFn = (async (_url: any, init: any) => {
      sentModel = JSON.parse(init.body as string).model;
      return jsonResponse({ model: "m", choices: [{ message: { content: "x" } }] });
    }) as unknown as typeof fetch;
    const client = createGatewayClient({
      baseUrl: "http://gw",
      fetchFn,
      models: { judge: "judge-strong" },
    });
    await client.judge({ messages: [{ role: "user", content: "?" }] });
    expect(sentModel).toBe("judge-strong");
  });

  it("rerank POSTs the Cohere-compatible /rerank passthrough and maps relevance_score", async () => {
    const fetchFn = (async (url: any, init: any) => {
      const sent = JSON.parse(init.body as string);
      expect(String(url)).toBe("http://gw/rerank");
      expect(sent).toMatchObject({ model: "rerank", query: "q", top_n: 2 });
      return jsonResponse({
        model: "cohere/rerank-v3.5",
        results: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.4 },
        ],
      });
    }) as unknown as typeof fetch;
    const client = createGatewayClient({ baseUrl: "http://gw", fetchFn });
    const r = await client.rerank({ query: "q", documents: ["a", "b"], topN: 2 });
    expect(r.results).toEqual([
      { index: 1, relevanceScore: 0.9 },
      { index: 0, relevanceScore: 0.4 },
    ]);
    expect(r.model).toBe("cohere/rerank-v3.5");
  });

  it("normalizes a trailing slash in baseUrl", async () => {
    let calledUrl = "";
    const fetchFn = (async (url: any) => {
      calledUrl = String(url);
      return jsonResponse({ model: "m", choices: [{ message: { content: "x" } }] });
    }) as unknown as typeof fetch;
    const client = createGatewayClient({ baseUrl: "http://gw/", fetchFn });
    await client.extract({ messages: [] });
    expect(calledUrl).toBe("http://gw/chat/completions");
  });

  it("maps a non-2xx response to an internal error", async () => {
    const fetchFn = (async () => jsonResponse({ error: "boom" }, 500)) as unknown as typeof fetch;
    // maxAttempts: 1 — this test is about the status->error mapping, not retry; THE-615's retry
    // behavior gets its own describe block below.
    const client = createGatewayClient({ baseUrl: "http://gw", fetchFn, maxAttempts: 1 });
    await expect(client.extract({ messages: [] })).rejects.toMatchObject({ code: "internal" });
  });

  it("maps an abort to operation_timeout", async () => {
    const fetchFn = (async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as unknown as typeof fetch;
    const client = createGatewayClient({
      baseUrl: "http://gw",
      fetchFn,
      timeoutMs: 5,
      maxAttempts: 1,
    });
    await expect(client.judge({ messages: [] })).rejects.toMatchObject({
      code: "operation_timeout",
    });
  });

  it("resolveGatewayUrl prefers the explicit URL then OBSIDIAN_TC_GATEWAY_URL", () => {
    expect(resolveGatewayUrl("http://explicit")).toBe("http://explicit");
    const prev = process.env.OBSIDIAN_TC_GATEWAY_URL;
    process.env.OBSIDIAN_TC_GATEWAY_URL = "http://env";
    try {
      expect(resolveGatewayUrl()).toBe("http://env");
    } finally {
      if (prev === undefined) delete process.env.OBSIDIAN_TC_GATEWAY_URL;
      else process.env.OBSIDIAN_TC_GATEWAY_URL = prev;
    }
  });

  // THE-923: post's catch previously attached `cause: (e as Error).message`, which was always
  // the constant "fetch failed" string, never the actual reason. cause_code (the shared
  // extractCauseCode unwrapper) replaces it.
  it("attaches cause_code from a rejection carrying cause.code", async () => {
    const fetchFn = (async () =>
      Promise.reject(
        Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
      )) as unknown as typeof fetch;
    const client = createGatewayClient({ baseUrl: "http://gw", fetchFn, maxAttempts: 1 });
    await expect(client.extract({ messages: [] })).rejects.toMatchObject({
      code: "internal",
      details: { cause_code: "ECONNREFUSED" },
    });
  });

  it("omits cause_code when the rejection's .code is a URL-bearing string, not a code", async () => {
    const fetchFn = (async () =>
      Promise.reject(
        Object.assign(new Error("boom"), { code: "https://user:secret@host/leaky?x=1" }),
      )) as unknown as typeof fetch;
    const client = createGatewayClient({ baseUrl: "http://gw", fetchFn, maxAttempts: 1 });
    const e = await client.extract({ messages: [] }).catch((err) => err);
    expect(e.code).toBe("internal");
    expect(e.details && "cause_code" in e.details).toBe(false);
  });

  it("throws when no base URL is configured", () => {
    const prev = process.env.OBSIDIAN_TC_GATEWAY_URL;
    delete process.env.OBSIDIAN_TC_GATEWAY_URL;
    try {
      expect(() => createGatewayClient({})).toThrow();
    } finally {
      if (prev !== undefined) process.env.OBSIDIAN_TC_GATEWAY_URL = prev;
    }
  });
});

// THE-615 — bounded retry with backoff. A stub `fetchFn` that fails N times then succeeds is
// the prescribed way to prove the per-attempt AbortController/timeout actually resets, since a
// controller reused across retries would abort attempt 2 immediately (it inherits attempt 1's
// already-fired signal).
describe("gateway client retry (THE-615)", () => {
  it("retries a transient network throw and succeeds on the next attempt", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("ECONNRESET");
      return jsonResponse({ model: "m", choices: [{ message: { content: "ok" } }] });
    }) as unknown as typeof fetch;
    const client = createGatewayClient({
      baseUrl: "http://gw",
      fetchFn,
      maxAttempts: 2,
      retryBaseDelayMs: 1,
      sleepFn: async () => {},
    });
    const r = await client.extract({ messages: [] });
    expect(r.text).toBe("ok");
    expect(calls).toBe(2);
  });

  it(
    "retries a per-attempt timeout with a FRESH AbortController — a reused, already-fired " +
      "signal would abort the retry instantly",
    async () => {
      let calls = 0;
      const fetchFn = (async (_url: any, init: any) => {
        calls += 1;
        if (calls === 1) {
          // Simulate the first attempt hanging until ITS OWN per-attempt timer fires.
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => {
              const e = new Error("aborted");
              e.name = "AbortError";
              reject(e);
            });
          });
        }
        // If the client reused attempt 1's controller, this signal would already be aborted.
        expect(init.signal.aborted).toBe(false);
        return jsonResponse({ model: "m", choices: [{ message: { content: "ok" } }] });
      }) as unknown as typeof fetch;
      const client = createGatewayClient({
        baseUrl: "http://gw",
        fetchFn,
        timeoutMs: 5,
        maxAttempts: 2,
        retryBaseDelayMs: 1,
        sleepFn: async () => {},
      });
      const r = await client.extract({ messages: [] });
      expect(r.text).toBe("ok");
      expect(calls).toBe(2);
    },
  );

  it("retries a 5xx up to maxAttempts with exponential backoff, then throws the typed error", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return jsonResponse({}, 503);
    }) as unknown as typeof fetch;
    const delays: number[] = [];
    const client = createGatewayClient({
      baseUrl: "http://gw",
      fetchFn,
      maxAttempts: 3,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 1000,
      sleepFn: async (ms) => {
        delays.push(ms);
      },
    });
    await expect(client.extract({ messages: [] })).rejects.toMatchObject({ code: "internal" });
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]); // base * 2^(attempt-1), same formula as job-queue.ts
  });

  it("never retries a 4xx — retrying our own bad request just repeats the same mistake", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return jsonResponse({}, 400);
    }) as unknown as typeof fetch;
    const client = createGatewayClient({ baseUrl: "http://gw", fetchFn, maxAttempts: 3 });
    await expect(client.extract({ messages: [] })).rejects.toMatchObject({ code: "internal" });
    expect(calls).toBe(1);
  });

  it("a bare 429 (no Retry-After) is terminal, like other 4xx", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return jsonResponse({}, 429);
    }) as unknown as typeof fetch;
    const client = createGatewayClient({ baseUrl: "http://gw", fetchFn, maxAttempts: 3 });
    await expect(client.extract({ messages: [] })).rejects.toMatchObject({ code: "internal" });
    expect(calls).toBe(1);
  });

  it("a 429 with Retry-After is retried, honoring the header's delay over the backoff formula", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({}), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "2" },
        });
      }
      return jsonResponse({ model: "m", choices: [{ message: { content: "ok" } }] });
    }) as unknown as typeof fetch;
    const delays: number[] = [];
    const client = createGatewayClient({
      baseUrl: "http://gw",
      fetchFn,
      maxAttempts: 2,
      retryBaseDelayMs: 100,
      sleepFn: async (ms) => {
        delays.push(ms);
      },
    });
    const r = await client.extract({ messages: [] });
    expect(r.text).toBe("ok");
    expect(calls).toBe(2);
    expect(delays).toEqual([2000]); // Retry-After: 2 (seconds) wins over the 100ms backoff base
  });
});

// THE-617 item 4 — a lightweight liveness probe, folded into THE-615's retry work per the
// ticket (worth doing only alongside the client's other resilience changes, not standalone).
describe("gateway client ping (THE-617)", () => {
  it("GETs LiteLLM's /health and returns true on 2xx", async () => {
    let calledUrl = "";
    let method = "";
    const fetchFn = (async (url: any, init: any) => {
      calledUrl = String(url);
      method = init?.method;
      return jsonResponse({ status: "healthy" });
    }) as unknown as typeof fetch;
    const client = createGatewayClient({ baseUrl: "http://gw", fetchFn });
    await expect(client.ping()).resolves.toBe(true);
    expect(calledUrl).toBe("http://gw/health");
    expect(method).toBe("GET");
  });

  it("returns false (never throws) on a non-2xx, a network error, or a timeout — and never retries", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return jsonResponse({}, 503);
    }) as unknown as typeof fetch;
    const client = createGatewayClient({ baseUrl: "http://gw", fetchFn, maxAttempts: 3 });
    await expect(client.ping()).resolves.toBe(false);
    expect(calls).toBe(1); // ping is a single-shot probe, not subject to the retry policy

    const throwingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client2 = createGatewayClient({ baseUrl: "http://gw", fetchFn: throwingFetch });
    await expect(client2.ping()).resolves.toBe(false);
  });
});
