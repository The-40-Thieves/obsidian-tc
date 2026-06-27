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
    const client = createGatewayClient({ baseUrl: "http://gw", fetchFn });
    await expect(client.extract({ messages: [] })).rejects.toMatchObject({ code: "internal" });
  });

  it("maps an abort to operation_timeout", async () => {
    const fetchFn = (async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as unknown as typeof fetch;
    const client = createGatewayClient({ baseUrl: "http://gw", fetchFn, timeoutMs: 5 });
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
