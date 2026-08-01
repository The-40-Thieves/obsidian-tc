import { ServerConfigSchema } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchFn } from "../src/embeddings/http";
import { rerankerProviderNames, resolveReranker } from "../src/providers/registry";
import { wireGatewaySeams } from "../src/runtime/tool-wiring";

// A fetch stub that hangs until its AbortSignal fires, then rejects with an AbortError — mirrors
// how the platform fetch reacts to AbortController.abort(). Same pattern as
// test/embeddings.test.ts's hangingFetch: pair with a short cfg.timeoutMs to prove that value
// actually reached postJson/createGatewayClient, without a real multi-second wait.
const hangingFetch: FetchFn = ((_url: string, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      reject(e);
    });
  })) as FetchFn;

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
    expect(rerankerProviderNames()).toEqual([
      "cohere-compatible",
      "gateway",
      "model-tier",
      "module",
    ]);
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

  // The absent-config case the first draft claimed to cover but did not. No `model` here —
  // model-tier ignores (and refuses) it; see the ignored-fields tests below. resolveReranker
  // itself legitimately returns null here — it is a shared resolution primitive, and other
  // callers (e.g. eval/CLI entry points) may want the raw null. The DECLARED-block-only
  // "null is a boot-time failure" enforcement lives one layer up, in tool-wiring.ts's
  // resolveDeclaredReranker — see the wireGatewaySeams describe block below for that behaviour.
  it("model-tier yields null when modelTier.full is unconfigured (resolveReranker's own contract, not the declared-block caller's)", async () => {
    const r = await resolveReranker(
      { provider: "model-tier" },
      { embeddings: { provider: "model-tier", model: "q", dimensions: 1024 } },
    );
    expect(r).toBeNull();
  });

  // model-tier sources its model/endpoint/auth from embeddings.modelTier.full.* — it reads NONE
  // of the reranker descriptor's model/baseUrl/apiKey/apiKeyEnv/timeoutMs. A schema-required
  // `model` field would make those fields unwritable, since RerankerConfigSchema.model is required
  // by cohere-compatible but must stay optional overall (Finding 1). Instead of silently discarding
  // whichever of these an operator writes, this entry refuses to build and names every one it saw.
  it("model-tier throws at boot if any field it ignores is set, naming each one and its real source", async () => {
    let message = "";
    try {
      await resolveReranker(
        { provider: "model-tier", model: "bge-reranker-v2-m3", timeoutMs: 5000 },
        { embeddings: { provider: "model-tier", model: "q", dimensions: 1024 } },
      );
    } catch (e) {
      message = JSON.stringify(e);
    }
    expect(message).toContain("reranker.model");
    expect(message).toContain("reranker.timeoutMs");
    expect(message).toContain("embeddings.modelTier.full");
    // Only the fields actually set are named — baseUrl/apiKey/apiKeyEnv were never set above.
    expect(message).not.toContain("reranker.baseUrl");
  });

  it("model-tier with no ignored fields set still resolves normally (the guard is opt-in, not unconditional)", async () => {
    const r = await resolveReranker(
      { provider: "model-tier" },
      {
        embeddings: {
          provider: "model-tier",
          model: "q",
          dimensions: 1024,
          modelTier: { dense: { baseUrl: "http://dense" }, full: { baseUrl: "http://full" } },
        },
      },
    );
    expect(r).not.toBeNull();
  });

  // appendsPath "" (Finding 2) means assertBaseUrlNotDuplicating no longer intercepts this with the
  // stale "already ends with /v1/rerank" message — the ignored-fields check (Finding 1) is what
  // catches it now, with an actionable message pointing at the real source.
  it("a baseUrl ending in the old '/v1/rerank' suffix is caught by the ignored-fields error, not the stale duplicate-segment message", async () => {
    let message = "";
    try {
      await resolveReranker(
        { provider: "model-tier", baseUrl: "http://stale-host/v1/rerank" },
        { embeddings: { provider: "model-tier", model: "q", dimensions: 1024 } },
      );
    } catch (e) {
      message = JSON.stringify(e);
    }
    expect(message).toContain("reranker.baseUrl");
    expect(message).not.toContain("already ends with");
  });

  it("cohere-compatible throws at boot if reranker.model is absent, naming the field", async () => {
    let message = "";
    try {
      await resolveReranker({ provider: "cohere-compatible", baseUrl: "http://gw:4001/v2" }, {});
    } catch (e) {
      message = JSON.stringify(e);
    }
    expect(message).toContain("reranker.model");
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

  // registry.ts's gateway entry also forwards c.timeoutMs into createGatewayClient's per-attempt
  // budget — not asserted above (that test only checks url/model/authorization). A hangingFetch +
  // a tiny timeoutMs proves the value reaches the client without a real multi-second wait: if the
  // mapping were dropped, this would hang until the DEFAULT 60s budget (and the default 3-attempt
  // retry loop) instead of failing in well under a second.
  it("gateway forwards the declared timeoutMs into the gateway client's request budget", async () => {
    const r = await resolveReranker(
      { provider: "gateway", model: "m", baseUrl: "http://gw", timeoutMs: 5 },
      { fetchFn: hangingFetch },
    );
    await expect(r?.("q", ["a", "b"], 1)).rejects.toMatchObject({ code: "operation_timeout" });
  });
});

describe("cohere-compatible forwards apiKey and timeoutMs (not just model/baseUrl)", () => {
  it("forwards apiKey as a Bearer authorization header", async () => {
    const { fetchFn, headers } = capture();
    const r = await resolveReranker({ ...CFG, apiKey: "top-secret" }, { fetchFn });
    await r?.("q", ["a", "b"], 1);
    expect(headers[0]?.authorization).toBe("Bearer top-secret");
  });

  it("omits the authorization header entirely when no apiKey is configured", async () => {
    const { fetchFn, headers } = capture();
    const r = await resolveReranker(CFG, { fetchFn });
    await r?.("q", ["a", "b"], 1);
    expect(headers[0]).not.toHaveProperty("authorization");
  });

  // A hangingFetch + a tiny timeoutMs proves c.timeoutMs reaches postJson: if the mapping were
  // dropped, this would hang until postJson's default 30s timeout instead of failing fast.
  it("forwards timeoutMs into the per-request budget", async () => {
    const r = await resolveReranker({ ...CFG, timeoutMs: 5 }, { fetchFn: hangingFetch });
    await expect(r?.("q", ["a", "b"], 1)).rejects.toMatchObject({ code: "operation_timeout" });
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

// Final-review blocker 1: the spec's error table permits a `null` reranker only for an ABSENT
// `reranker` block. A DECLARED block that resolves to null (model-tier without modelTier.full;
// gateway without a base URL) must throw at boot instead of silently degrading retrieval to
// RRF-only — the two cases above prove the absent-block path is unchanged, these two prove the
// declared-block path now fails loudly instead of falling back.
describe("wireGatewaySeams — a DECLARED block that resolves to null throws at boot", () => {
  const prevGatewayUrl = process.env.OBSIDIAN_TC_GATEWAY_URL;

  afterEach(() => {
    if (prevGatewayUrl === undefined) delete process.env.OBSIDIAN_TC_GATEWAY_URL;
    else process.env.OBSIDIAN_TC_GATEWAY_URL = prevGatewayUrl;
  });

  it("declared model-tier without embeddings.modelTier.full throws, naming the missing field", async () => {
    delete process.env.OBSIDIAN_TC_GATEWAY_URL;
    const embeddings = ServerConfigSchema.parse({
      vaults: [{ id: "main", path: "/v" }],
      embeddings: { provider: "ollama" },
    }).embeddings;
    const rerankerCfg = ServerConfigSchema.parse({
      vaults: [{ id: "main", path: "/v" }],
      reranker: { provider: "model-tier" },
    }).reranker;

    let message = "";
    await expect(
      wireGatewaySeams(embeddings, rerankerCfg).catch((e) => {
        message = JSON.stringify(e);
        throw e;
      }),
    ).rejects.toBeTruthy();
    expect(message).toContain("model-tier");
    expect(message).toContain("embeddings.modelTier.full");
  });

  it("declared gateway with no baseUrl and no OBSIDIAN_TC_GATEWAY_URL throws, naming both sources", async () => {
    delete process.env.OBSIDIAN_TC_GATEWAY_URL;
    const embeddings = ServerConfigSchema.parse({
      vaults: [{ id: "main", path: "/v" }],
      embeddings: { provider: "ollama" },
    }).embeddings;
    const rerankerCfg = ServerConfigSchema.parse({
      vaults: [{ id: "main", path: "/v" }],
      reranker: { provider: "gateway" },
    }).reranker;

    let message = "";
    await expect(
      wireGatewaySeams(embeddings, rerankerCfg).catch((e) => {
        message = JSON.stringify(e);
        throw e;
      }),
    ).rejects.toBeTruthy();
    expect(message).toContain("gateway");
    expect(message).toContain("reranker.baseUrl");
    expect(message).toContain("OBSIDIAN_TC_GATEWAY_URL");
  });
});
