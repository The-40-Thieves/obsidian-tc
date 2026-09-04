// Integration test against the REAL model — only runs when the pinned weights are present on disk
// (`bun run fetch-model`). Skipped, with a visible reason, otherwise: this must never force a 23 MB
// download in every CI job or every contributor's `vitest run`. This is the one test in this package
// that actually imports @huggingface/transformers (transitively, via src/index.ts's createReranker).
import { describe, expect, it, vi } from "vitest";
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

    // THE-944 review round 3 (G2): the "integration-shaped" test the re-review asked for — proves
    // the load path refuses through the REAL, unmodified loadSession itself when the model
    // directory is corrupted STRICTLY AFTER fetchAndVerifyModel published/verified it, not only
    // through a direct verifyModelDir/assertVerified unit call. Isolates the TOCTOU window
    // deterministically (a genuine race between two real async calls with no hook in between is
    // not reliably reproducible) by wrapping ONLY fetchAndVerifyModel's export: it still calls the
    // REAL implementation (real fetch/verify/publish against the real, already-cached weights, no
    // network needed once cached), then copies the returned, genuinely-verified directory to an
    // ISOLATED temp location and corrupts ONE file in the COPY — never touching the real, shared
    // fixture other tests in this file depend on. assertVerified itself is left completely real
    // and unmocked: this is what actually proves loadSession's wiring, not a stub standing in for
    // it. Mutation evidence (delete `await assertVerified(modelDir);` from src/index.ts): this
    // exact test goes from throwing the assertVerified-shaped error to throwing whatever
    // @huggingface/transformers itself produces trying to parse a corrupted config.json (or, if it
    // that library is generous enough to swallow it, resolving with a session built from bad
    // config) — see the fix-round report for the observed transcript.
    it("G2: loadSession refuses via the REAL load path when the cache is corrupted right after fetchAndVerifyModel publishes, not only via a direct verifyModelDir/assertVerified call", async () => {
      vi.resetModules();
      vi.doMock("../src/model-fetch.js", async () => {
        const actual =
          await vi.importActual<typeof import("../src/model-fetch.js")>("../src/model-fetch.js");
        return {
          ...actual,
          fetchAndVerifyModel: async (
            root: string,
            spec?: Parameters<typeof actual.fetchAndVerifyModel>[1],
          ) => {
            const realDir = await actual.fetchAndVerifyModel(root, spec);
            const { mkdtemp, cp, writeFile, stat } = await import("node:fs/promises");
            const { tmpdir } = await import("node:os");
            const { join } = await import("node:path");
            const tmpRoot = await mkdtemp(join(tmpdir(), "reranker-local-g2-toctou-"));
            const copyDir = join(tmpRoot, "copy");
            await cp(realDir, copyDir, { recursive: true });
            const target = join(copyDir, "config.json");
            const size = (await stat(target)).size;
            // Corrupt AFTER copying the real, verified bytes — simulates the file changing in the
            // gap between fetchAndVerifyModel's own verification and assertVerified's separate one.
            await writeFile(target, "x".repeat(size));
            return copyDir; // NOT realDir — the real, shared fixture is never touched.
          },
        };
      });
      try {
        const fresh = await import("../src/index.js");
        const reranker = fresh.createReranker({ localModelPath: defaultModelsDir() });
        await expect(reranker("q", ["doc"], 1)).rejects.toThrow(
          /failed verification immediately before load/,
        );
      } finally {
        vi.doUnmock("../src/model-fetch.js");
        vi.resetModules();
      }
    }, 30_000);
  },
);
