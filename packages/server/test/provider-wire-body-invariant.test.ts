// The generic adapter must send the MINIMAL common body. Three published incidents share one shape:
//   dimensions      -> 400 on any non-Matryoshka OpenAI-compatible backend (mem0 #4153)
//   encoding_format -> SDK default base64 breaks proxies; explicit null breaks vLLM (LiteLLM)
//   max_tokens_per_doc / max_chunks_per_doc -> Cohere rerank v2 vs v1
// Asserting the EXACT key set is the point: a test over present keys passes while an extra key 400s.
import { describe, expect, it } from "vitest";
import { createEmbeddingProvider } from "../src/embeddings";
import type { FetchFn } from "../src/embeddings/http";

function capture(): { fetchFn: FetchFn; urls: string[]; bodies: Array<Record<string, unknown>> } {
  const urls: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    urls.push(String(url));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const inputs = body.input as string[];
    return new Response(
      JSON.stringify({ data: inputs.map(() => ({ embedding: [0.1, 0.2, 0.3] })) }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as FetchFn;
  return { fetchFn, urls, bodies };
}

const BASE = { provider: "openai-compatible", model: "BAAI/bge-m3", dimensions: 3 } as const;

describe("openai-compatible wire body", () => {
  it("sends EXACTLY {model, input}", async () => {
    const { fetchFn, bodies } = capture();
    await createEmbeddingProvider({ ...BASE, baseUrl: "http://gw:4001/v1" }, { fetchFn }).embed([
      "hello",
    ]);
    expect(Object.keys(bodies[0] ?? {}).sort()).toEqual(["input", "model"]);
    expect(bodies[0]).toEqual({ model: "BAAI/bge-m3", input: ["hello"] });
  });

  it("appends /embeddings, tolerating a trailing slash", async () => {
    const a = capture();
    await createEmbeddingProvider(
      { ...BASE, baseUrl: "http://gw:4001/v1" },
      { fetchFn: a.fetchFn },
    ).embed(["x"]);
    const b = capture();
    await createEmbeddingProvider(
      { ...BASE, baseUrl: "http://gw:4001/v1/" },
      { fetchFn: b.fetchFn },
    ).embed(["x"]);
    expect(a.urls[0]).toBe("http://gw:4001/v1/embeddings");
    expect(b.urls[0]).toBe("http://gw:4001/v1/embeddings");
  });

  it("requires baseUrl", () => {
    expect(() => createEmbeddingProvider({ ...BASE })).toThrow(/baseUrl/);
  });

  it("refuses a baseUrl that would duplicate the appended path", () => {
    expect(() =>
      createEmbeddingProvider({ ...BASE, baseUrl: "http://gw:4001/v1/embeddings" }),
    ).toThrow(/embeddings/);
  });

  it("sends the bearer token when a key is configured", async () => {
    const { fetchFn } = capture();
    let auth: string | undefined;
    const spy = (async (url: string, init?: RequestInit) => {
      auth = new Headers(init?.headers).get("authorization") ?? undefined;
      return fetchFn(url, init);
    }) as FetchFn;
    await createEmbeddingProvider(
      { ...BASE, baseUrl: "http://gw:4001/v1", apiKey: "sk-x" },
      { fetchFn: spy },
    ).embed(["x"]);
    expect(auth).toBe("Bearer sk-x");
  });
});
