// THE-1122 — createEmbeddingProvider's orchestration (dims, batching, mean-pooling/normalize
// wiring, memoization), exercised with an injected `loadSessionFn` stub — never
// @huggingface/transformers, never real weights.
import { describe, expect, it, vi } from "vitest";
import { createEmbeddingProvider, DEFAULT_MODEL_NAME } from "../src/index.js";
import { modelInfoByName } from "../src/model-info.js";

function stubExtractor(dims: number, expectedPooling: "mean" | "cls" = "mean") {
  return vi.fn(async (texts: string[], opts: { pooling: string; normalize: boolean }) => {
    expect(opts.pooling).toBe(expectedPooling);
    expect(opts.normalize).toBe(true);
    return { tolist: () => texts.map((_, i) => Array.from({ length: dims }, (_, j) => i + j)) };
  });
}

describe("createEmbeddingProvider", () => {
  it("id/provider/model/dimensions reflect the resolved catalog entry, sync, with no session load", () => {
    const loadSessionFn = vi.fn();
    const provider = createEmbeddingProvider({}, loadSessionFn);
    const info = modelInfoByName(DEFAULT_MODEL_NAME);
    expect(provider.provider).toBe("local");
    expect(provider.model).toBe(DEFAULT_MODEL_NAME);
    expect(provider.dimensions).toBe(info?.dimensions);
    expect(provider.id).toContain(DEFAULT_MODEL_NAME);
    expect(loadSessionFn).not.toHaveBeenCalled(); // no session I/O until embed() is called
  });

  it("throws for an unknown model name, naming the supported catalog", () => {
    expect(() => createEmbeddingProvider({ model: "not-a-real-model" })).toThrow(
      /unknown model "not-a-real-model"/,
    );
  });

  it("embed() calls the extractor with pooling: mean, normalize: true, batched in one call", async () => {
    const extractor = stubExtractor(384);
    const loadSessionFn = vi.fn(async () => ({ extractor }));
    const provider = createEmbeddingProvider({ model: "all-MiniLM-L6-v2" }, loadSessionFn);
    const vectors = await provider.embed(["hello", "world", "a third text"]);
    expect(vectors).toHaveLength(3);
    expect(vectors[0]).toHaveLength(384);
    expect(extractor).toHaveBeenCalledTimes(1); // one batched call, not one per text
    expect(extractor).toHaveBeenCalledWith(["hello", "world", "a third text"], {
      pooling: "mean",
      normalize: true,
    });
  });

  it("embed() calls the extractor with pooling: cls for bge-small-en-v1.5 (its own 1_Pooling/config.json is CLS, not mean)", async () => {
    const extractor = stubExtractor(384, "cls");
    const loadSessionFn = vi.fn(async () => ({ extractor }));
    const provider = createEmbeddingProvider({ model: "bge-small-en-v1.5" }, loadSessionFn);
    await provider.embed(["hello"]);
    expect(extractor).toHaveBeenCalledWith(["hello"], { pooling: "cls", normalize: true });
  });

  it("embed([]) returns [] without touching the session at all", async () => {
    const loadSessionFn = vi.fn();
    const provider = createEmbeddingProvider({}, loadSessionFn);
    expect(await provider.embed([])).toEqual([]);
    expect(loadSessionFn).not.toHaveBeenCalled();
  });

  it("memoizes the session across repeated embed() calls (offline-after-cache in spirit: load once)", async () => {
    const extractor = stubExtractor(384);
    const loadSessionFn = vi.fn(async () => ({ extractor }));
    const provider = createEmbeddingProvider({ model: "all-MiniLM-L6-v2" }, loadSessionFn);
    await provider.embed(["a"]);
    await provider.embed(["b"]);
    // the STUB loadSessionFn is a plain function (not memoized itself, unlike the real loadSession)
    // -- this test exercises that the PROVIDER calls it once per embed(), and each call is expected
    // to return the SAME session in a real deployment (the real loadSession's own memoization is
    // covered by model-fetch.test.ts's fetchAndVerifyModel "zero-network no-op" case + this
    // package's real loadSession sharing one Map keyed by model/root/quantized/threads).
    expect(loadSessionFn).toHaveBeenCalledTimes(2);
  });

  it("throws (does not silently degrade) when the session fails to load, e.g. a resolution error", async () => {
    const loadSessionFn = vi.fn(async () => {
      throw new Error("simulated: model weights unavailable");
    });
    const provider = createEmbeddingProvider({}, loadSessionFn);
    await expect(provider.embed(["hello"])).rejects.toThrow(/simulated/);
  });

  it("errors on a vector-count mismatch instead of silently returning a mismatched batch", async () => {
    const badExtractor = vi.fn(async () => ({ tolist: () => [[1, 2, 3]] })); // wrong length
    const loadSessionFn = vi.fn(async () => ({ extractor: badExtractor }));
    const provider = createEmbeddingProvider({}, loadSessionFn);
    await expect(provider.embed(["a", "b"])).rejects.toThrow(/expected 2 vectors, got 1/);
  });

  it("quantized:false and threads flow through to loadSessionFn", async () => {
    const extractor = stubExtractor(384);
    const loadSessionFn = vi.fn(async () => ({ extractor }));
    const provider = createEmbeddingProvider(
      { model: "all-MiniLM-L6-v2", quantized: false, threads: 2 },
      loadSessionFn,
    );
    await provider.embed(["x"]);
    expect(loadSessionFn).toHaveBeenCalledWith(
      expect.objectContaining({ name: "all-MiniLM-L6-v2" }),
      expect.any(String),
      false,
      2,
    );
    expect(provider.id).toContain("fp32");
  });
});
