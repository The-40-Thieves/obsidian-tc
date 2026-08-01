// doctor derives multiVector and reranker readiness from hardcoded provider names, so every
// drop-in provider reports multiVector:false and "reranking depends on the inference gateway"
// even with a reranker block configured. Both must key on what is CONFIGURED, not on a name.
import { describe, expect, it } from "vitest";
import { type RetrievalHeadsView, retrievalHeadsCheck } from "../src/doctor/checks";

// NOTE: retrievalHeadsCheck(...) returns { id, category, run } — the computed detail strings only
// exist in run()'s return value. JSON.stringify on the un-run Check drops `run` (a function) and
// would make every assertion below vacuous, so each case below calls `.run(ctx)` before asserting.
const ctx = { serverVersion: "1.10.0" };

const VIEW: RetrievalHeadsView = {
  denseProvider: "openai-compatible",
  denseModel: "BAAI/bge-m3",
  denseDimensions: 1024,
  multiVector: false,
  sparseEnabled: false,
  colbertEnabled: false,
};

describe("doctor with a generic provider", () => {
  it("does not claim model-tier rerank capability for an unknown provider name", () => {
    const c = retrievalHeadsCheck(VIEW).run(ctx);
    expect(JSON.stringify(c)).not.toMatch(/model-tier \/ ColBERT rerank capable/);
  });

  it("names a configured reranker instead of claiming gateway dependence", () => {
    const c = retrievalHeadsCheck({ ...VIEW, rerankerConfigured: "cohere-compatible" }).run(ctx);
    expect(JSON.stringify(c)).toContain("cohere-compatible");
    expect(JSON.stringify(c)).not.toMatch(/reranking depends on the inference gateway/);
  });

  it("still reports model-tier capability when it genuinely applies", () => {
    const c = retrievalHeadsCheck({ ...VIEW, denseProvider: "model-tier", multiVector: true }).run(
      ctx,
    );
    expect(JSON.stringify(c)).toMatch(/model-tier \/ ColBERT rerank capable/);
  });
});
