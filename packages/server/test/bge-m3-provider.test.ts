// THE-395 — the configurable bge-m3 provider ("provider": "bge-m3" against a vLLM base).
// Dense-only embed() speaks the OpenAI-compatible /embeddings endpoint; embedFull() returns the
// three heads via the THE-388 encoder, with the dense width asserted like every other provider.
import { describe, expect, it } from "vitest";
import { createEmbeddingProvider } from "../src/embeddings";
import type { FetchFn } from "../src/embeddings/http";

function mockFetch(byKey: Record<string, unknown>): FetchFn {
  return (async (url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as { task?: string };
    const key = url.endsWith("/embeddings")
      ? "embeddings"
      : url.endsWith("/tokenize")
        ? "tokenize"
        : `pooling:${body.task}`;
    return new Response(JSON.stringify(byKey[key] ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as FetchFn;
}

const CFG = { provider: "bge-m3", model: "BAAI/bge-m3", dimensions: 3, baseUrl: "http://x/v1" };

describe("THE-395 bge-m3 provider", () => {
  it("embed() returns dense vectors from the OpenAI-compatible endpoint", async () => {
    const fetchFn = mockFetch({ embeddings: { data: [{ embedding: [0.1, 0.2, 0.3] }] } });
    const p = createEmbeddingProvider(CFG, { fetchFn });
    expect(p.provider).toBe("bge-m3");
    expect(await p.embed(["hello"])).toEqual([[0.1, 0.2, 0.3]]);
  });

  it("embedFull() returns all three heads with the dense width asserted", async () => {
    const fetchFn = mockFetch({
      embeddings: { data: [{ embedding: [0.1, 0.2, 0.3] }] },
      "pooling:token_classify": { data: [{ data: [0.9, 0.5] }] },
      tokenize: { tokens: [7, 8] },
      "pooling:token_embed": {
        data: [
          {
            data: [
              [1, 0],
              [0, 1],
            ],
          },
        ],
      },
    });
    const p = createEmbeddingProvider(CFG, { fetchFn });
    expect(p.embedFull).toBeDefined();
    const [out] = (await p.embedFull?.(["hello"])) ?? [];
    expect(out?.dense).toEqual([0.1, 0.2, 0.3]);
    expect(out?.sparse).toEqual({ "7": 0.9, "8": 0.5 });
    expect(out?.colbert).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it("dense-only providers still omit embedFull (indexer stores dense only)", () => {
    const p = createEmbeddingProvider({
      provider: "ollama",
      model: "nomic-embed-text",
      dimensions: 768,
    });
    expect(p.embedFull).toBeUndefined();
  });
});
