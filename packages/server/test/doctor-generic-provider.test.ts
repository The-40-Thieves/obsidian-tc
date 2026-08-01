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

  // Review round 2 (Important): the no-reranker-configured branch's wording ALSO changed from the
  // old "reranking depends on the inference gateway (env-configured)" — that claim went false for
  // the no-block case too, not just the rerankerConfigured-present one, the moment Task 5 shipped
  // config.reranker as a second path. doctor-checks.test.ts only pins `toContain("RRF-only")`, so
  // that rewrite slipped through green CI undisclosed. Pin the FULL string here (`toBe`/`toEqual`,
  // not `toContain`/`toMatch`) so any future edit to either branch's message is a deliberate,
  // reviewed change in THIS file rather than an unnoticed side effect.
  it("pins the exact text of the no-reranker-configured branch", async () => {
    const r = await retrievalHeadsCheck(VIEW).run(ctx);
    expect(r.details?.reranker).toBe(
      "RRF-only — no reranker configured, and multi-vector capability could not be determined from the 'openai-compatible' provider name",
    );
    expect(r.notes).toEqual([
      "no reranker configured, and multi-vector capability could not be determined from the 'openai-compatible' provider name",
    ]);
  });

  it("names a configured reranker instead of claiming gateway dependence", async () => {
    const r = await retrievalHeadsCheck({ ...VIEW, rerankerConfigured: "cohere-compatible" }).run(
      ctx,
    );
    expect(r.details?.reranker).toBe("reranker configured: cohere-compatible");
    expect(r.notes).toEqual(["reranker configured (cohere-compatible) — a declared block wins"]);
    expect(JSON.stringify(r)).not.toMatch(/reranking depends on the inference gateway/);
  });

  it("still reports model-tier capability when it genuinely applies", () => {
    const c = retrievalHeadsCheck({ ...VIEW, denseProvider: "model-tier", multiVector: true }).run(
      ctx,
    );
    expect(JSON.stringify(c)).toMatch(/model-tier \/ ColBERT rerank capable/);
  });
});
