// THE-679 + THE-681. Two doctor gaps that shared a cause: doctor answered from provider NAMES.
import { describe, expect, it } from "vitest";
import { rerankerBuildableCheck } from "../src/doctor/checks";
import { type RetrievalHeadsView, retrievalHeadsCheck } from "../src/doctor/retrieval-heads";
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

  // THE-705 round 2 (adversarial review, confirmed finding 2 / THE-688 lesson). Unlike model-tier
  // and gateway, whether "local" resolves is NOT answerable from config alone — so this check must
  // NOT claim "no known build blocker" (that would be exactly THE-688's "dense: ready" mistake: a
  // literal that looks like it checked something but didn't). It probes via the INJECTED
  // `probeLocalReranker` (never a real import here — see that field's own doctor/checks.ts
  // comment for why this specific injection point exists).
  it("FAILS 'local' when the injected probe reports it could not resolve, and names the remedy", async () => {
    const r = await rerankerBuildableCheck({
      rerankerProvider: "local",
      probeLocalReranker: async () => ({
        ok: false,
        attempts: [
          "bare-specifier: @the-40-thieves/obsidian-tc-reranker-local — Cannot find module",
          "source-checkout: /x/reranker-local/dist/index.js — not built",
        ],
      }),
    }).run(ctx);
    expect(r.status).toBe("fail");
    expect(r.summary).toMatch(/could not be resolved/);
    expect(r.summary).toMatch(/does NOT fail to boot/);
    expect(r.details?.attempts).toEqual([
      "bare-specifier: @the-40-thieves/obsidian-tc-reranker-local — Cannot find module",
      "source-checkout: /x/reranker-local/dist/index.js — not built",
    ]);
    expect(String(r.remediation)).toMatch(/localModulePath/);
    expect(String(r.remediation)).toMatch(/bun add/);
    expect(String(r.remediation)).toMatch(/bun run build/);
  });

  it("PASSES 'local' when the injected probe reports it resolved, naming the route", async () => {
    const r = await rerankerBuildableCheck({
      rerankerProvider: "local",
      probeLocalReranker: async () => ({
        ok: true,
        route: "source-checkout",
        attempts: ["bare-specifier: ... — Cannot find module", "source-checkout: ... — resolved"],
      }),
    }).run(ctx);
    expect(r.status).toBe("ok");
    expect(r.summary).toContain("source-checkout");
  });

  // Real callers (cli/commands/doctor.ts) always inject `probeLocalReranker` for a declared
  // "local" block. This proves the check does not SILENTLY claim health when nobody wired the
  // probe (e.g. a future direct caller of rerankerBuildableCheck that forgets it) — it falls back
  // to the same "no known build blocker" a `module` provider gets, never a false "ok, resolved".
  it("falls back to the generic 'no known build blocker' for 'local' when no probe is injected — never claims resolved", async () => {
    const r = await rerankerBuildableCheck({ rerankerProvider: "local" }).run(ctx);
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
