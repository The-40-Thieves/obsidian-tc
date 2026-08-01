// THE-679 + THE-681. Two doctor gaps that shared a cause: doctor answered from provider NAMES.
import { describe, expect, it } from "vitest";
import {
  type RetrievalHeadsView,
  rerankerBuildableCheck,
  retrievalHeadsCheck,
} from "../src/doctor/checks";
import type { DoctorContext } from "../src/doctor/types";

const ctx = {} as DoctorContext;

describe("reranker.buildable (THE-679)", () => {
  it("FAILS the exact config that hard-fails boot: model-tier without embeddings.modelTier.full", async () => {
    const r = await rerankerBuildableCheck({
      rerankerProvider: "model-tier",
      embeddings: {},
    }).run(ctx);
    expect(r.status).toBe("fail");
    expect(r.summary).toMatch(/embeddings\.modelTier\.full is not configured/);
    expect(String(r.remediation)).toMatch(/modelTier\.full/);
  });

  it("passes when modelTier.full IS configured", async () => {
    const r = await rerankerBuildableCheck({
      rerankerProvider: "model-tier",
      embeddings: { modelTier: { full: { baseUrl: "http://bge:8000" } } },
    }).run(ctx);
    expect(r.status).toBe("ok");
  });

  it("FAILS gateway with no baseUrl and no env var", async () => {
    const r = await rerankerBuildableCheck({ rerankerProvider: "gateway" }).run(ctx);
    expect(r.status).toBe("fail");
    expect(r.summary).toMatch(/no gateway base URL is configured/);
  });

  it("passes gateway when the env var supplies the URL", async () => {
    const r = await rerankerBuildableCheck({
      rerankerProvider: "gateway",
      gatewayUrlEnv: "http://gw:4001",
    }).run(ctx);
    expect(r.status).toBe("ok");
  });

  it("never probes a module provider — diagnosing must not execute operator code", async () => {
    const r = await rerankerBuildableCheck({ rerankerProvider: "module" }).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.summary).toMatch(/no known build blocker/);
  });

  it("is a no-op when no reranker block is declared", async () => {
    expect((await rerankerBuildableCheck({}).run(ctx)).status).toBe("ok");
  });
});

describe("retrieval.heads branch order (THE-681)", () => {
  const base: RetrievalHeadsView = {
    denseProvider: "model-tier",
    denseModel: "Qwen3",
    denseDimensions: 1024,
    multiVector: true,
    sparseEnabled: false,
    colbertEnabled: false,
  };

  it("names the DECLARED reranker even when the provider looks multi-vector capable", async () => {
    // The runtime uses cohere-compatible here (a declared block wins in tool-wiring.ts). The old
    // branch order reported "model-tier / ColBERT rerank capable" and never named it.
    const r = await retrievalHeadsCheck({ ...base, rerankerConfigured: "cohere-compatible" }).run(
      ctx,
    );
    expect(String(r.details?.reranker)).toContain("cohere-compatible");
    expect(String(r.details?.reranker)).not.toMatch(/model-tier \/ ColBERT rerank capable/);
  });

  it("still reports model-tier capability when no block is declared", async () => {
    const r = await retrievalHeadsCheck(base).run(ctx);
    expect(String(r.details?.reranker)).toMatch(/model-tier \/ ColBERT rerank capable/);
  });
});
