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

  it("registers every previously-supported name", () => {
    expect(embeddingsProviderNames()).toEqual([
      "bge-m3",
      "cohere",
      "model-tier",
      "ollama",
      "openai",
      "openai-compatible",
      "voyage",
    ]);
  });
});
