import { ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import {
  createEmbeddingProvider,
  deterministicVector,
  fakeEmbeddingProvider,
  resolveApiKey,
} from "../src/embeddings";
import { postJson } from "../src/embeddings/http";
import { ollamaProvider } from "../src/embeddings/providers";
import { jsCosineSimilarity } from "../src/search/native";

// A fetch stub returning a fixed JSON body — no network, fully deterministic.
function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

// A fetch stub that hangs until its AbortSignal fires, then rejects with an
// AbortError — mirrors how the platform fetch reacts to AbortController.abort().
const hangingFetch: typeof fetch = ((_url: string, init?: { signal?: AbortSignal }) =>
  new Promise((_res, reject) => {
    init?.signal?.addEventListener("abort", () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      reject(e);
    });
  })) as unknown as typeof fetch;

describe("deterministic fake embeddings", () => {
  it("is deterministic and L2-normalized", async () => {
    const p = fakeEmbeddingProvider({ dimensions: 16 });
    const a = (await p.embed(["hello world"]))[0] ?? [];
    const b = (await p.embed(["hello world"]))[0] ?? [];
    expect(a).toEqual(b);
    expect(a).toHaveLength(16);
    const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("ranks shared-token text above disjoint text by cosine", () => {
    const base = deterministicVector("alpha beta gamma", 64);
    const near = deterministicVector("alpha beta delta", 64);
    const far = deterministicVector("xyzzy plugh frobnicate", 64);
    expect(jsCosineSimilarity(base, near)).toBeGreaterThan(jsCosineSimilarity(base, far));
  });
});

describe("api key resolution", () => {
  it("prefers the config key, then falls back to the env var", () => {
    expect(resolveApiKey("openai", "cfg-123")).toBe("cfg-123");
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "env-456";
    try {
      expect(resolveApiKey("openai")).toBe("env-456");
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
      else process.env.OPENAI_API_KEY = prev;
    }
    expect(resolveApiKey("ollama")).toBeUndefined();
  });
});

describe("provider factory", () => {
  const cfg = { provider: "ollama", model: "nomic-embed-text", dimensions: 8 };

  it("selects the provider named in config", () => {
    expect(createEmbeddingProvider(cfg).provider).toBe("ollama");
    expect(createEmbeddingProvider({ ...cfg, provider: "openai" }).provider).toBe("openai");
    expect(createEmbeddingProvider({ ...cfg, provider: "voyage" }).provider).toBe("voyage");
    expect(createEmbeddingProvider({ ...cfg, provider: "cohere" }).provider).toBe("cohere");
  });

  it("rejects an unknown provider with invalid_input", () => {
    try {
      createEmbeddingProvider({ ...cfg, provider: "nope" });
      throw new Error("expected createEmbeddingProvider to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ObsidianTcError);
      expect((e as ObsidianTcError).code).toBe("invalid_input");
    }
  });

  it("honors an explicit override without inspecting config", () => {
    const fake = fakeEmbeddingProvider();
    expect(createEmbeddingProvider(cfg, { override: fake })).toBe(fake);
  });
});

describe("provider adapters over a stub fetch", () => {
  it("parses an ollama /api/embed response", async () => {
    const p = createEmbeddingProvider(
      { provider: "ollama", model: "m", dimensions: 3 },
      {
        fetchFn: jsonFetch({
          embeddings: [
            [1, 0, 0],
            [0, 1, 0],
          ],
        }),
      },
    );
    expect(await p.embed(["a", "b"])).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
  });

  it("parses an openai-style data[].embedding response", async () => {
    const p = createEmbeddingProvider(
      { provider: "openai", model: "m", dimensions: 2, apiKey: "secret" },
      { fetchFn: jsonFetch({ data: [{ embedding: [1, 2] }] }) },
    );
    expect(await p.embed(["a"])).toEqual([[1, 2]]);
  });

  it("parses a cohere embeddings.float response", async () => {
    const p = createEmbeddingProvider(
      { provider: "cohere", model: "m", dimensions: 2 },
      { fetchFn: jsonFetch({ embeddings: { float: [[3, 4]] } }) },
    );
    expect(await p.embed(["a"])).toEqual([[3, 4]]);
  });

  it("cohere encodes queries as search_query and documents as search_document (THE-308)", async () => {
    const bodies: Array<{ input_type?: string }> = [];
    const capturingFetch = (async (_url: string, init?: { body?: string }) => {
      bodies.push(init?.body ? JSON.parse(init.body) : {});
      return new Response(JSON.stringify({ embeddings: { float: [[1, 2]] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const p = createEmbeddingProvider(
      { provider: "cohere", model: "m", dimensions: 2 },
      { fetchFn: capturingFetch },
    );
    await p.embed(["a document"]); // default → document
    await p.embed(["a query"], { input: "query" });
    expect(bodies[0]?.input_type).toBe("search_document");
    expect(bodies[1]?.input_type).toBe("search_query");
  });

  it("maps a non-2xx response to embedding_provider_error", async () => {
    const p = createEmbeddingProvider(
      { provider: "ollama", model: "m", dimensions: 3 },
      { fetchFn: jsonFetch({ error: "boom" }, 500) },
    );
    await expect(p.embed(["a"])).rejects.toMatchObject({ code: "embedding_provider_error" });
  });

  it("maps a wrong-dimension vector to embedding_provider_error without leaking the key", async () => {
    const p = createEmbeddingProvider(
      { provider: "openai", model: "m", dimensions: 5, apiKey: "secret" },
      { fetchFn: jsonFetch({ data: [{ embedding: [1, 2] }] }) },
    );
    try {
      await p.embed(["a"]);
      throw new Error("expected embed to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ObsidianTcError);
      expect((e as ObsidianTcError).code).toBe("embedding_provider_error");
      expect(JSON.stringify((e as ObsidianTcError).toJSON())).not.toContain("secret");
    }
  });

  it("maps an aborted request to operation_timeout", async () => {
    await expect(
      postJson({
        url: "http://127.0.0.1:0/embed",
        body: {},
        provider: "ollama",
        credentialSlot: "none",
        timeoutMs: 5,
        fetchFn: hangingFetch,
      }),
    ).rejects.toMatchObject({ code: "operation_timeout" });
  });

  // THE-923: postJson's rejection catch previously discarded the fetch cause entirely.
  it("attaches cause_code from a rejection carrying cause.code", async () => {
    const rejectingFetch: typeof fetch = (async () =>
      Promise.reject(
        Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
      )) as unknown as typeof fetch;
    try {
      await postJson({
        url: "http://127.0.0.1:0/embed",
        body: {},
        provider: "ollama",
        credentialSlot: "none",
        fetchFn: rejectingFetch,
      });
      throw new Error("expected postJson to throw");
    } catch (e) {
      expect((e as ObsidianTcError).code).toBe("embedding_provider_error");
      expect((e as ObsidianTcError).details?.cause_code).toBe("ECONNREFUSED");
    }
  });

  it("omits cause_code when the rejection's .code is a URL-bearing string, not a code", async () => {
    const rejectingFetch: typeof fetch = (async () =>
      Promise.reject(
        Object.assign(new Error("boom"), { code: "https://user:secret@host/leaky?x=1" }),
      )) as unknown as typeof fetch;
    try {
      await postJson({
        url: "http://127.0.0.1:0/embed",
        body: {},
        provider: "ollama",
        credentialSlot: "none",
        fetchFn: rejectingFetch,
      });
      throw new Error("expected postJson to throw");
    } catch (e) {
      const err = e as ObsidianTcError;
      expect(err.code).toBe("embedding_provider_error");
      expect(err.details && "cause_code" in err.details).toBe(false);
    }
  });
});

// THE-680: postJson is shared by the embedding adapters, BOTH reranker adapters and the two
// model-tier service clients. Before credentialSlot every failure named embeddings.apiKey, so a
// rerank operator was sent to a key they never need to set. These pin the hint per slot — the text
// is the whole product of providerHint, and nothing asserted it before.
describe("postJson failure hints name the right config block", () => {
  const failingFetch: typeof fetch = async () =>
    new Response("nope", { status: 401, statusText: "Unauthorized" });

  // THE-837: PostJsonOptions became a discriminated union (credentialLessHint is reachable only on
  // the `none` slot). A bare `Omit` over a union is NOT distributive — it collapses the members
  // into one object whose credentialSlot is the full union, which then satisfies no branch. The
  // conditional type below distributes over the members so each keeps its own discriminant, which
  // is what lets this helper still parameterise over all four slots.
  type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

  async function hintFor(
    o: DistributiveOmit<Parameters<typeof postJson>[0], "url" | "body" | "fetchFn">,
  ) {
    try {
      await postJson({
        url: "http://127.0.0.1:9/x",
        body: {},
        fetchFn: failingFetch,
        ...o,
      });
    } catch (e) {
      return String((e as ObsidianTcError).details?.hint ?? "");
    }
    throw new Error("expected postJson to throw");
  }

  it("names reranker.apiKey for a rerank endpoint, never embeddings.apiKey", async () => {
    const hint = await hintFor({ provider: "cohere-compatible", credentialSlot: "reranker" });
    expect(hint).toContain("reranker.apiKey");
    expect(hint).toContain("reranker.apiKeyEnv");
    expect(hint).not.toContain("embeddings.apiKey");
  });

  it("names embeddings.apiKey for an embedding endpoint", async () => {
    const hint = await hintFor({ provider: "openai-compatible", credentialSlot: "embeddings" });
    expect(hint).toContain("embeddings.apiKey");
    expect(hint).not.toContain("reranker.apiKey");
  });

  // The second reranker (bge-reranker, model/bge.ts) authenticates from the modelTier.full block,
  // so BOTH of the other two answers would be wrong for it.
  it("names modelTier.full.authToken for the model-tier services", async () => {
    const hint = await hintFor({ provider: "bge-reranker", credentialSlot: "modelTierFull" });
    expect(hint).toContain("embeddings.modelTier.full.authToken");
    expect(hint).not.toContain("reranker.apiKey");
    expect(hint).not.toMatch(/set embeddings\.apiKey/);
  });

  // TEI and bare vLLM are sent no credential at all: "configure a key" is a third wrong answer.
  it("tells an unauthenticated endpoint that no key applies", async () => {
    const hint = await hintFor({ provider: "tei", credentialSlot: "none" });
    expect(hint).toMatch(/no credential/);
    expect(hint).not.toContain("apiKey");
    expect(hint).not.toContain("authToken");
  });

  // THE-837. This block replaces a test that asserted the OPPOSITE — that postJson kept an
  // Ollama-specific hint of its own. It did, via `provider === "ollama"` inside the `none` slot,
  // which made the transport shared by every adapter privilege one vendor. The advice did not go
  // away; it moved to the adapter that owns it. All three cases below are needed: the first two
  // prove the transport is neutral and the mechanism works, and WITHOUT the third they would both
  // pass with the hint deleted outright rather than relocated.
  it("gives a vendor-specific provider NO special hint when none is supplied", async () => {
    const hint = await hintFor({ provider: "ollama", credentialSlot: "none" });
    expect(hint).toMatch(/no credential/);
    expect(hint).not.toContain("ollama pull");
  });

  it("lets an adapter's own credential-less hint win", async () => {
    const hint = await hintFor({
      provider: "anything",
      credentialSlot: "none",
      credentialLessHint: "is the widget service up?",
    });
    expect(hint).toBe("is the widget service up?");
  });

  it("still reaches the operator from the ollama adapter, end to end", async () => {
    // The acceptance criterion, and the only one of the three that would catch the hint being
    // dropped instead of moved. Drives the real adapter, not postJson directly.
    const dead: typeof fetch = async () => new Response("nope", { status: 503 });
    const provider = ollamaProvider({
      model: "bge-m3",
      dimensions: 8,
      baseUrl: "http://127.0.0.1:9",
      fetchFn: dead,
    });
    try {
      await provider.embed(["hello"]);
      throw new Error("expected the adapter to throw");
    } catch (e) {
      const hint = String((e as ObsidianTcError).details?.hint ?? "");
      expect(hint).toContain("ollama pull bge-m3");
      expect(hint).toContain("http://127.0.0.1:9");
      // The model name is interpolated, never a hardcoded default — a fixed model name here would
      // re-privilege one checkpoint the same way the branch privileged one vendor.
      expect(hint).not.toContain("nomic-embed-text");
      expect(hint).not.toContain("apiKey");
    }
  });

  // All three throw sites carry the hint, not just the wire-failure one. The malformed-JSON path is
  // a 2xx, so it is the easiest of the three to leave behind when this function changes.
  it("carries the slot-correct hint on a malformed 2xx body, not only on a wire failure", async () => {
    const badJson: typeof fetch = async () =>
      new Response("<html>not json</html>", { status: 200 });
    try {
      await postJson({
        url: "http://127.0.0.1:9/rerank",
        body: {},
        provider: "cohere-compatible",
        credentialSlot: "reranker",
        fetchFn: badJson,
      });
      throw new Error("expected postJson to throw");
    } catch (e) {
      expect((e as ObsidianTcError).code).toBe("embedding_provider_error");
      expect(String((e as ObsidianTcError).details?.hint)).toContain("reranker.apiKey");
    }
  });
});
