import { ObsidianTcError } from "@obsidian-tc/shared";
import { describe, expect, it } from "vitest";
import {
  createEmbeddingProvider,
  deterministicVector,
  fakeEmbeddingProvider,
  resolveApiKey,
} from "../src/embeddings";
import { postJson } from "../src/embeddings/http";
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
        timeoutMs: 5,
        fetchFn: hangingFetch,
      }),
    ).rejects.toMatchObject({ code: "operation_timeout" });
  });
});
