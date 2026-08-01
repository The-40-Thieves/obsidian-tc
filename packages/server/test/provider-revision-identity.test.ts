// THE-460 fix B (review round 1): a declared revision must change `provider.id`, because that's
// the identity chunk_embeddings.model / vec_chunks.model store AND what note-plan.ts's re-embed
// gate compares (`ex.active_model !== model`). Applied at the factory (embeddings/index.ts's
// withRevision, the same seam withPrefixes uses) so no individual adapter needs to know about it.
import { describe, expect, it } from "vitest";
import { createEmbeddingProvider, type EmbeddingsConfigLike } from "../src/embeddings";

const CFG: EmbeddingsConfigLike = {
  provider: "ollama",
  model: "bge-m3",
  dimensions: 8,
};

describe("createEmbeddingProvider folds a declared revision into provider.id", () => {
  it("a declared revision suffixes provider.id with @<revision>", () => {
    const without = createEmbeddingProvider(CFG);
    const withRev = createEmbeddingProvider({ ...CFG, revision: "rev1" });
    expect(withRev.id).toBe(`${without.id}@rev1`);
  });

  it("two different revisions produce two different ids", () => {
    const r1 = createEmbeddingProvider({ ...CFG, revision: "rev1" });
    const r2 = createEmbeddingProvider({ ...CFG, revision: "rev2" });
    expect(r1.id).not.toBe(r2.id);
  });

  it("an absent revision leaves provider.id byte-identical to today's", () => {
    expect(createEmbeddingProvider({ ...CFG, revision: undefined }).id).toBe(
      createEmbeddingProvider(CFG).id,
    );
  });

  // Config validation (z.string().min(1)) already refuses "", but the wrapper is a second line of
  // defense — it must not silently produce a trailing `...@` id if ever called with one directly.
  it("an empty-string revision is treated as absent", () => {
    expect(createEmbeddingProvider({ ...CFG, revision: "" }).id).toBe(
      createEmbeddingProvider(CFG).id,
    );
  });

  it("provider, model, and dimensions are untouched by a revision suffix", () => {
    const p = createEmbeddingProvider({ ...CFG, revision: "rev1" });
    expect(p.provider).toBe("ollama");
    expect(p.model).toBe("bge-m3");
    expect(p.dimensions).toBe(8);
  });
});
