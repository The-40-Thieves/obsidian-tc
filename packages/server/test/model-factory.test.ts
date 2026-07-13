import { describe, expect, it } from "vitest";
import type { FetchFn } from "../src/embeddings/http";
import type { ModelClient } from "../src/model";
import { buildModelTierProvider, modelClientProvider } from "../src/model";

// embed() and embedFull() return DIFFERENT dense vectors so a test can prove the merge takes dense
// from embed (Qwen) and sparse/ColBERT from embedFull (BGE), not the other way round.
function fakeClient(seen?: { embed: string[][]; full: string[][] }): ModelClient {
  return {
    embed: async (req) => {
      seen?.embed.push(req.texts);
      return {
        model: "qwen",
        revision: "r1",
        vectors: req.texts.map(() => [1, 1]),
        dimensions: 2,
        pooling: "last-token",
        normalized: true,
      };
    },
    embedFull: async (req) => {
      seen?.full.push(req.texts);
      return {
        model: "bge",
        revision: "r2",
        items: req.texts.map(() => ({ dense: [9, 9], sparse: { "5": 0.5 }, colbert: [[1, 0]] })),
      };
    },
  };
}

describe("modelClientProvider (ModelClient -> EmbeddingProvider adapter)", () => {
  it("embed returns the dense stream; embedFull merges dense(Qwen) + sparse/colbert(BGE)", async () => {
    const p = modelClientProvider(fakeClient(), {
      id: "model-tier:qwen",
      provider: "model-tier",
      model: "qwen",
      dimensions: 2,
    });
    expect(p.id).toBe("model-tier:qwen");
    expect(p.provider).toBe("model-tier");
    expect(p.dimensions).toBe(2);
    expect(await p.embed(["a"])).toEqual([[1, 1]]);
    const full = await p.embedFull?.(["a", "b"]);
    expect(full).toEqual([
      { dense: [1, 1], sparse: { "5": 0.5 }, colbert: [[1, 0]] },
      { dense: [1, 1], sparse: { "5": 0.5 }, colbert: [[1, 0]] },
    ]);
  });

  it("applies queryPrefix to the dense query only, never to the BGE (embedFull) call", async () => {
    const seen = { embed: [] as string[][], full: [] as string[][] };
    const p = modelClientProvider(fakeClient(seen), {
      id: "x",
      provider: "model-tier",
      model: "qwen",
      dimensions: 2,
      queryPrefix: "Q: ",
    });
    await p.embed(["hi"], { input: "query" });
    await p.embedFull?.(["doc"], { input: "query" });
    expect(seen.embed).toEqual([["Q: hi"], ["Q: doc"]]); // Instruct prefix on the Qwen dense query
    expect(seen.full).toEqual([["doc"]]); // BGE always gets the raw text
  });

  it("omits embedFull when the client has no multi-vector backend (dense-only)", () => {
    const denseOnly: ModelClient = {
      embed: async (req) => ({
        model: "q",
        revision: "r",
        vectors: req.texts.map(() => [0, 0]),
        dimensions: 2,
        pooling: "last-token",
        normalized: true,
      }),
    };
    const p = modelClientProvider(denseOnly, {
      id: "x",
      provider: "model-tier",
      model: "q",
      dimensions: 2,
    });
    expect(p.embedFull).toBeUndefined();
  });
});

describe("buildModelTierProvider (config -> provider)", () => {
  it("throws when the modelTier block is absent", () => {
    expect(() => buildModelTierProvider({ dimensions: 2 })).toThrow(/modelTier/);
  });

  it("wires Qwen TEI (dense) + BGE service (multi-vector) behind one EmbeddingProvider", async () => {
    // one fetch answering BOTH the TEI dense endpoint and the BGE /v1/encode endpoint, keyed by URL.
    const fetchFn = (async (input: unknown, init?: { body?: unknown }) => {
      const url = String(input);
      if (url.includes("/v1/encode")) {
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        return new Response(
          JSON.stringify({
            model: "BAAI/bge-m3",
            revision: "b1",
            items: body.input.map(() => ({
              dense: [7, 7],
              sparse: { token_ids: [9], weights: [0.9] },
              colbert: { vectors: [[1, 1]] },
            })),
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/info")) return new Response("{}", { status: 200 });
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(
        JSON.stringify({
          data: body.input.map((_t, index) => ({ embedding: [2, 2], index })),
          model: "Qwen/Qwen3-Embedding-0.6B",
        }),
        { status: 200 },
      );
    }) as unknown as FetchFn;

    const p = buildModelTierProvider(
      {
        dimensions: 2,
        modelTier: {
          dense: { baseUrl: "http://tei:8080", model: "Qwen/Qwen3-Embedding-0.6B" },
          full: { baseUrl: "http://bge:8002", authToken: "tok" },
        },
      },
      { fetchFn },
    );
    expect(p.provider).toBe("model-tier");
    expect(p.id).toBe("model-tier:Qwen/Qwen3-Embedding-0.6B");
    expect(p.dimensions).toBe(2);
    expect(await p.embed(["q"])).toEqual([[2, 2]]); // dense from Qwen/TEI
    const full = await p.embedFull?.(["d"]);
    expect(full).toEqual([{ dense: [2, 2], sparse: { "9": 0.9 }, colbert: [[1, 1]] }]); // Qwen dense + BGE heads
  });

  it("dense-only when no full backend is configured", () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ data: [], model: "q" }), {
        status: 200,
      })) as unknown as FetchFn;
    const p = buildModelTierProvider(
      { dimensions: 2, modelTier: { dense: { baseUrl: "http://tei:8080" } } },
      { fetchFn },
    );
    expect(p.embedFull).toBeUndefined();
  });
});
