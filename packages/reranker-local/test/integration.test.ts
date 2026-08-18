// Integration test against the REAL model — only runs when the pinned weights are present on disk
// (`bun run fetch-model`). Skipped, with a visible reason, otherwise: this must never force a 23 MB
// download in every CI job or every contributor's `vitest run`. This is the one test in this package
// that actually imports @huggingface/transformers (transitively, via src/index.ts's createReranker).
import { describe, expect, it } from "vitest";
import { createReranker, defaultModelsDir, weightsPresent } from "../src/index.js";

const present = weightsPresent();

describe.skipIf(!present)(
  present
    ? "createReranker (real model)"
    : `createReranker (real model) — SKIPPED: weights not found under ${defaultModelsDir()}. Run "bun run fetch-model" in packages/reranker-local to enable this test.`,
  () => {
    it("ranks an obviously-relevant document above an obviously-irrelevant one", async () => {
      const reranker = createReranker();
      const query = "What is the capital of France?";
      const docs = [
        "Bananas are a good source of potassium and are yellow when ripe.",
        "Paris is the capital and most populous city of France.",
        "The quarterly report showed a 3% increase in regional sales.",
      ];
      const hits = await reranker(query, docs, 0);
      expect(hits).toHaveLength(3);
      expect(hits[0]?.index).toBe(1); // the Paris sentence
      expect(hits[0]?.relevanceScore).toBeGreaterThan(hits[1]?.relevanceScore ?? 1);
      expect(hits[0]?.relevanceScore).toBeGreaterThan(hits[2]?.relevanceScore ?? 1);
      for (const h of hits) {
        expect(h.relevanceScore).toBeGreaterThanOrEqual(0);
        expect(h.relevanceScore).toBeLessThanOrEqual(1);
      }
    }, 30_000); // Cold model load (~1-3s per the research brief) plus CPU inference on a shared/slow host.

    it("memoizes the session across calls — a second rerank() does not reload the model", async () => {
      const reranker = createReranker();
      const t0 = performance.now();
      await reranker("q", ["warm the session up"], 0);
      const firstMs = performance.now() - t0;

      const t1 = performance.now();
      await reranker("q", ["a second call"], 0);
      const secondMs = performance.now() - t1;

      // Not a tight timing assertion (shared host, CV noted in THE-510) — just that the second call
      // is not paying a multi-second model-load cost again.
      expect(secondMs).toBeLessThan(Math.max(firstMs, 2000));
    }, 30_000);
  },
);
