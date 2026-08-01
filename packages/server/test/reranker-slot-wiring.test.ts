import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchFn } from "../src/embeddings/http";
import { rerankerProviderNames, resolveReranker } from "../src/providers/registry";
import { wireGatewaySeams } from "../src/runtime/tool-wiring";

function capture(): {
  fetchFn: FetchFn;
  urls: string[];
  bodies: Array<Record<string, unknown>>;
  headers: Array<Record<string, string>>;
} {
  const urls: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const headers: Array<Record<string, string>> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    urls.push(String(url));
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    headers.push((init?.headers as Record<string, string>) ?? {});
    return new Response(
      JSON.stringify({ model: "rerank-v3.5", results: [{ index: 1, relevance_score: 0.9 }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as FetchFn;
  return { fetchFn, urls, bodies, headers };
}

const CFG = { provider: "cohere-compatible", model: "rerank-v3.5", baseUrl: "http://gw:4001/v2" };

describe("reranker slot", () => {
  it("registers the expected names", () => {
    expect(rerankerProviderNames()).toEqual(["cohere-compatible", "gateway", "model-tier"]);
  });

  it("sends EXACTLY {model, query, documents} when topN is 0", async () => {
    const { fetchFn, bodies } = capture();
    const r = await resolveReranker(CFG, { fetchFn });
    await r?.("q", ["a", "b"], 0);
    expect(Object.keys(bodies[0] ?? {}).sort()).toEqual(["documents", "model", "query"]);
  });

  it("adds top_n only when positive, never a truncation parameter", async () => {
    const { fetchFn, bodies, urls } = capture();
    const r = await resolveReranker(CFG, { fetchFn });
    const hits = await r?.("q", ["a", "b"], 2);
    expect(Object.keys(bodies[0] ?? {}).sort()).toEqual(["documents", "model", "query", "top_n"]);
    expect(bodies[0]).not.toHaveProperty("max_tokens_per_doc");
    expect(bodies[0]).not.toHaveProperty("max_chunks_per_doc");
    expect(urls[0]).toBe("http://gw:4001/v2/rerank");
    expect(hits).toEqual([{ index: 1, relevanceScore: 0.9 }]);
  });

  it("throws on an unknown name, listing every registered one", async () => {
    let message = "";
    try {
      await resolveReranker({ provider: "no-such-reranker", model: "m" }, {});
    } catch (e) {
      message = JSON.stringify(e);
    }
    expect(rerankerProviderNames().length).toBeGreaterThan(0);
    for (const name of rerankerProviderNames()) expect(message).toContain(name);
  });

  // The absent-config case the first draft claimed to cover but did not.
  it("model-tier yields null when modelTier.full is unconfigured, so the caller falls back", async () => {
    const r = await resolveReranker(
      { provider: "model-tier", model: "bge-reranker-v2-m3" },
      { embeddings: { provider: "model-tier", model: "q", dimensions: 1024 } },
    );
    expect(r).toBeNull();
  });

  it("gateway yields null when no gateway URL is configured", async () => {
    const prev = process.env.OBSIDIAN_TC_GATEWAY_URL;
    delete process.env.OBSIDIAN_TC_GATEWAY_URL;
    try {
      expect(await resolveReranker({ provider: "gateway", model: "rerank" }, {})).toBeNull();
    } finally {
      if (prev !== undefined) process.env.OBSIDIAN_TC_GATEWAY_URL = prev;
    }
  });

  // GatewayClientOptions names them token/rerankModel/timeoutMs (gateway/client.ts:62-74).
  // Dropping the mapping silently falls back to env vars and the model literal "rerank" — this
  // proves the declared apiKey/model actually reach the wire, not just that a client got built.
  it("gateway forwards the declared apiKey/model as token/rerankModel, not env vars or the literal 'rerank'", async () => {
    const { fetchFn, urls, bodies, headers } = capture();
    const r = await resolveReranker(
      {
        provider: "gateway",
        model: "my-declared-rerank-model",
        baseUrl: "http://gw",
        apiKey: "sekret",
      },
      { fetchFn },
    );
    await r?.("q", ["a", "b"], 1);
    expect(urls[0]).toBe("http://gw/rerank");
    expect(bodies[0]?.model).toBe("my-declared-rerank-model");
    expect(headers[0]?.authorization).toBe("Bearer sekret");
  });
});

// THE HIGHEST-RISK CONSTRAINT: an ABSENT reranker block must preserve today's precedence exactly
// (model-tier ?? gateway, else null) — a regression here changes behaviour for every deployment
// that has never heard of the new `reranker` key. Exercises wireGatewaySeams directly rather than
// resolveReranker, because that precedence chain lives in tool-wiring.ts, not the registry.
describe("wireGatewaySeams — absent-block precedence is unchanged", () => {
  const prevGatewayUrl = process.env.OBSIDIAN_TC_GATEWAY_URL;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevGatewayUrl === undefined) delete process.env.OBSIDIAN_TC_GATEWAY_URL;
    else process.env.OBSIDIAN_TC_GATEWAY_URL = prevGatewayUrl;
  });

  function embeddingsWith(modelTierFullBaseUrl?: string) {
    return ServerConfigSchema.parse({
      vaults: [{ id: "main", path: "/v" }],
      embeddings: modelTierFullBaseUrl
        ? {
            provider: "model-tier",
            dimensions: 4,
            modelTier: {
              dense: { baseUrl: "http://dense" },
              full: { baseUrl: modelTierFullBaseUrl },
            },
          }
        : { provider: "ollama" },
    }).embeddings;
  }

  it("neither model-tier.full nor a gateway URL configured -> null, exactly as before", async () => {
    delete process.env.OBSIDIAN_TC_GATEWAY_URL;
    const { reranker } = await wireGatewaySeams(embeddingsWith());
    expect(reranker).toBeNull();
  });

  it("only model-tier.full configured -> the model-tier reranker is reachable", async () => {
    delete process.env.OBSIDIAN_TC_GATEWAY_URL;
    const { reranker } = await wireGatewaySeams(embeddingsWith("http://model-tier-full"));
    expect(reranker).not.toBeNull();
  });

  it("only a gateway URL configured -> the gateway reranker is reachable", async () => {
    process.env.OBSIDIAN_TC_GATEWAY_URL = "http://gw";
    const { reranker } = await wireGatewaySeams(embeddingsWith());
    expect(reranker).not.toBeNull();
  });

  it("BOTH configured, no reranker block -> model-tier wins over gateway (unchanged precedence)", async () => {
    process.env.OBSIDIAN_TC_GATEWAY_URL = "http://gw";
    const hits: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        hits.push(String(url));
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }),
    );
    const { reranker } = await wireGatewaySeams(embeddingsWith("http://model-tier-full"));
    await reranker?.("q", ["a"], 1);
    // If precedence flipped (?? swapped for the gateway fallback, or the model-tier branch
    // dropped), this would hit http://gw/rerank instead.
    expect(hits).toEqual(["http://model-tier-full/v1/rerank"]);
  });

  it("a declared reranker block wins even when model-tier.full is ALSO configured", async () => {
    process.env.OBSIDIAN_TC_GATEWAY_URL = "http://gw";
    const hits: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        hits.push(String(url));
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }),
    );
    const rerankerCfg = ServerConfigSchema.parse({
      vaults: [{ id: "main", path: "/v" }],
      reranker: {
        provider: "cohere-compatible",
        model: "rerank-v3.5",
        baseUrl: "http://declared/v2",
      },
    }).reranker;
    const { reranker } = await wireGatewaySeams(
      embeddingsWith("http://model-tier-full"),
      rerankerCfg,
    );
    await reranker?.("q", ["a"], 1);
    expect(hits).toEqual(["http://declared/v2/rerank"]);
  });
});
