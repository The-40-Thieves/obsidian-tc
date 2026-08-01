// Task 1 — the switch → registry move must be INVISIBLE. All SIX names, not five: the first draft
// omitted model-tier from the metadata cases and only listed it in the name assertion.
import { describe, expect, it } from "vitest";
import { createEmbeddingProvider } from "../src/embeddings";
import { embeddingsProviderNames } from "../src/providers/registry";

const CASES = [
  { provider: "ollama", model: "bge-m3", dimensions: 1024, id: "ollama:bge-m3" },
  {
    provider: "openai",
    model: "text-embedding-3-small",
    dimensions: 1536,
    id: "openai:text-embedding-3-small",
  },
  { provider: "voyage", model: "voyage-3", dimensions: 1024, id: "voyage:voyage-3" },
  { provider: "cohere", model: "embed-v4.0", dimensions: 1024, id: "cohere:embed-v4.0" },
  { provider: "bge-m3", model: "BAAI/bge-m3", dimensions: 1024, id: "bge-m3:BAAI/bge-m3" },
];

describe("provider registry back-compat", () => {
  for (const c of CASES) {
    it(`${c.provider} resolves with an unchanged id`, () => {
      const p = createEmbeddingProvider({
        provider: c.provider,
        model: c.model,
        dimensions: c.dimensions,
      });
      expect(p.id).toBe(c.id);
      expect(p.provider).toBe(c.provider);
      expect(p.model).toBe(c.model);
      expect(p.dimensions).toBe(c.dimensions);
    });
  }

  // model-tier takes a different shape (its own config sub-object) and bypasses withPrefixes,
  // so it needs its own case rather than a row in CASES.
  it("model-tier resolves and keeps its own prefixing", () => {
    const p = createEmbeddingProvider({
      provider: "model-tier",
      model: "Qwen/Qwen3-Embedding-0.6B",
      dimensions: 1024,
      modelTier: { dense: { baseUrl: "http://tei:8080" } },
    });
    expect(p.provider).toBe("model-tier");
    expect(p.dimensions).toBe(1024);
  });

  // THE-678: the nested modelTier.*.revision knobs are provenance-only, and their describe() now
  // says so and points the operator at the top-level embeddings.revision instead. That redirection
  // is only honest while the top-level knob actually reaches model-tier — applyWrappers calls
  // withRevision BEFORE the `ownsPrefixing` early return, which is the one line holding it up. This
  // pins the claim so a reordering there fails here instead of silently making the doc a lie.
  it("top-level embeddings.revision reaches model-tier, despite it owning its own prefixing", () => {
    const base = {
      provider: "model-tier",
      model: "Qwen/Qwen3-Embedding-0.6B",
      dimensions: 1024,
      modelTier: { dense: { baseUrl: "http://tei:8080" } },
    } as const;
    const plain = createEmbeddingProvider(base);
    const pinned = createEmbeddingProvider({ ...base, revision: "chk2" });
    expect(pinned.id).toContain("chk2");
    expect(pinned.id).not.toBe(plain.id);
  });

  // The other half of the same claim: the NESTED knob is inert. If someone later folds
  // modelTier.dense.revision into provider.id, this fails and the describe() must be rewritten —
  // which is the point, since folding it would invalidate every existing model-tier index.
  it("nested modelTier.dense.revision moves nothing, as its describe() states", () => {
    const base = {
      provider: "model-tier",
      model: "Qwen/Qwen3-Embedding-0.6B",
      dimensions: 1024,
    } as const;
    const plain = createEmbeddingProvider({
      ...base,
      modelTier: { dense: { baseUrl: "http://tei:8080" } },
    });
    const nested = createEmbeddingProvider({
      ...base,
      modelTier: { dense: { baseUrl: "http://tei:8080", revision: "chk2" } },
    });
    expect(nested.id).toBe(plain.id);
  });

  // Deferred Minor from an earlier task: model-tier's EmbeddingsEntry.appendsPath used to be
  // "/v1/embeddings", but buildModelTierProvider never reads the descriptor's top-level baseUrl —
  // it reads cfg.modelTier.{dense,full}.baseUrl instead. That mismatch made the duplicate-segment
  // guard fire on a baseUrl this adapter never consumes, and taught a wrong mental model (the
  // suffix it told the operator to strip would still be ignored afterwards). appendsPath is now ""
  // for this entry, so a top-level baseUrl — even one ending in the OLD suffix — no longer throws.
  it("model-tier tolerates (and ignores) a top-level baseUrl ending in the old '/v1/embeddings' suffix", () => {
    const p = createEmbeddingProvider({
      provider: "model-tier",
      model: "Qwen/Qwen3-Embedding-0.6B",
      dimensions: 1024,
      baseUrl: "http://stale-host/v1/embeddings",
      modelTier: { dense: { baseUrl: "http://tei:8080" } },
    });
    expect(p.provider).toBe("model-tier");
  });

  it("registers every previously-supported name", () => {
    expect(embeddingsProviderNames()).toEqual([
      "bge-m3",
      "cohere",
      "model-tier",
      "module",
      "ollama",
      "openai",
      "openai-compatible",
      "voyage",
    ]);
  });
});
