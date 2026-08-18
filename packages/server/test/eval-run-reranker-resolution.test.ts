// THE-806 step 2: the eval harness used to build its `--gated-rerank` reranker from ONE source
// only — `RERANK_URL`, a Cohere/Jina-shaped `/rerank` HTTP probe (THE-394). That is a second
// instance of the exact defect THE-806 step 1 fixed for the hardness gate: production selects a
// reranker via `config.reranker` (provider registry — cohere-compatible / model-tier / gateway /
// local / module), and the eval harness had no way to reach that path at all, so a golden-set
// result for `--gated-rerank` could only ever describe an HTTP backend nothing in this deployment
// runs (`RERANK_URL` requires standing up a separate TEI/vLLM server; production's `local` provider
// is an in-process module).
//
// `buildEvalReranker` is the fix: RERANK_URL keeps working (`resolveRerankerFn` is never called
// when it's set — same precedence config/load.ts's applyEnvOverlays uses everywhere else, an
// explicit env var wins), and when it is unset the eval now goes through the SAME
// `resolveReranker` factory production's boot path calls (runtime/tool-wiring.ts), reading
// `config.reranker` from the eval config JSON. `resolveRerankerFn` is injected here so this test
// never imports the real provider registry (and, transitively, never needs
// @huggingface/transformers or the local reranker's model weights) to prove the wiring.
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it, vi } from "vitest";
import { buildEvalReranker } from "../eval/run";
import type { Reranker } from "../src/search/rerank";

// Minimal stand-in — buildEvalReranker only reads `.reranker`/`.embeddings` and forwards
// `.embeddings` untouched to the injected resolver, so the test never needs a fully-shaped
// ServerConfig["embeddings"] (batchSize, concurrency, etc. all carry schema defaults it never
// reads).
const FAKE_EMBEDDINGS = {
  provider: "openai",
  model: "m",
  dimensions: 4,
} as unknown as ServerConfig["embeddings"];

describe("buildEvalReranker (THE-806 step 2)", () => {
  it("returns null when neither RERANK_URL nor config.reranker is set", async () => {
    const resolveRerankerFn = vi.fn();
    const reranker = await buildEvalReranker(
      { reranker: undefined, embeddings: FAKE_EMBEDDINGS },
      { configDir: "/cfg", resolveRerankerFn },
    );
    expect(reranker).toBeNull();
    expect(resolveRerankerFn).not.toHaveBeenCalled();
  });

  it("RERANK_URL set: builds the legacy HTTP closure and never calls resolveRerankerFn, even when config.reranker is ALSO set", async () => {
    const resolveRerankerFn = vi.fn();
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ results: [{ index: 1, relevance_score: 0.9 }] }), {
          status: 200,
        }),
    );
    const reranker = await buildEvalReranker(
      { reranker: { provider: "local" }, embeddings: FAKE_EMBEDDINGS },
      { configDir: "/cfg", rerankUrl: "http://127.0.0.1:9/", fetchFn, resolveRerankerFn },
    );
    expect(resolveRerankerFn).not.toHaveBeenCalled();
    expect(reranker).not.toBeNull();
    const hits = await reranker?.("q", ["a", "b"], 1);
    expect(hits).toEqual([{ index: 1, relevanceScore: 0.9 }]);
    expect(fetchFn).toHaveBeenCalledWith(
      "http://127.0.0.1:9/rerank",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("RERANK_URL unset, config.reranker set: resolves via resolveRerankerFn with the config's reranker block, configDir and embeddings", async () => {
    const sentinel: Reranker = async () => [];
    const resolveRerankerFn = vi.fn().mockResolvedValue(sentinel);
    const reranker = await buildEvalReranker(
      { reranker: { provider: "local" }, embeddings: FAKE_EMBEDDINGS },
      { configDir: "/abs/cfg-dir", resolveRerankerFn },
    );
    expect(reranker).toBe(sentinel);
    expect(resolveRerankerFn).toHaveBeenCalledWith(
      { provider: "local" },
      expect.objectContaining({ configDir: "/abs/cfg-dir", embeddings: FAKE_EMBEDDINGS }),
    );
  });

  it("RERANK_URL unset, config.reranker unset: returns null without calling resolveRerankerFn", async () => {
    const resolveRerankerFn = vi.fn();
    const reranker = await buildEvalReranker(
      { reranker: undefined, embeddings: FAKE_EMBEDDINGS },
      { configDir: "/cfg", resolveRerankerFn },
    );
    expect(reranker).toBeNull();
    expect(resolveRerankerFn).not.toHaveBeenCalled();
  });
});
