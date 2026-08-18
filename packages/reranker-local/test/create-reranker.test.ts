// Stubbed-inference-fn tests — exercise createReranker's tokenize -> model -> rank wiring with a
// fake Session, so this always runs (no @huggingface/transformers, no model weights needed).
import { describe, expect, it, vi } from "vitest";
import { createReranker, type Session } from "../src/index.js";

function stubSession(logitsByDoc: number[]): Session {
  const tokenizer = vi.fn((_queries: string[], _opts: unknown) => ({ input_ids: [] }));
  const model = vi.fn(async (_inputs: unknown) => ({ logits: { data: logitsByDoc } }));
  return { tokenizer, model };
}

describe("createReranker (stubbed session)", () => {
  it("returns [] without loading a session when documents is empty", async () => {
    const loadSessionFn = vi.fn();
    const reranker = createReranker({}, loadSessionFn);
    const hits = await reranker("q", [], 5);
    expect(hits).toEqual([]);
    expect(loadSessionFn).not.toHaveBeenCalled();
  });

  it("tokenizes query paired with EVERY document (text_pair), batched in one call", async () => {
    const session = stubSession([0, 0, 0]);
    const reranker = createReranker({}, async () => session);
    await reranker("what is a vault", ["doc a", "doc b", "doc c"], 0);
    expect(session.tokenizer).toHaveBeenCalledTimes(1);
    expect(session.tokenizer).toHaveBeenCalledWith(
      ["what is a vault", "what is a vault", "what is a vault"],
      expect.objectContaining({ text_pair: ["doc a", "doc b", "doc c"] }),
    );
  });

  it("truncates and pads per the fixed pair-token budget", async () => {
    const session = stubSession([0]);
    const reranker = createReranker({}, async () => session);
    await reranker("q", ["doc"], 0);
    expect(session.tokenizer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ padding: true, truncation: true, max_length: 256 }),
    );
  });

  it("ranks by the model's logits, not input order", async () => {
    const session = stubSession([-1, 4, 0]); // doc0 low, doc1 high, doc2 mid
    const reranker = createReranker({}, async () => session);
    const hits = await reranker("q", ["a", "b", "c"], 0);
    expect(hits.map((h) => h.index)).toEqual([1, 2, 0]);
  });

  it("passes topN through to the ranking step", async () => {
    const session = stubSession([1, 2, 3]);
    const reranker = createReranker({}, async () => session);
    const hits = await reranker("q", ["a", "b", "c"], 1);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.index).toBe(2);
  });

  it("loads the session lazily — the loader is not called until the first rerank() call", async () => {
    const loadSessionFn = vi.fn(async () => stubSession([1]));
    createReranker({}, loadSessionFn); // constructing must not touch the loader
    expect(loadSessionFn).not.toHaveBeenCalled();
    const reranker = createReranker({}, loadSessionFn);
    await reranker("q", ["doc"], 0);
    expect(loadSessionFn).toHaveBeenCalledTimes(1);
  });

  it("forwards localModelPath through to the session loader", async () => {
    const loadSessionFn = vi.fn(async () => stubSession([1]));
    const reranker = createReranker({ localModelPath: "/custom/models" }, loadSessionFn);
    await reranker("q", ["doc"], 0);
    expect(loadSessionFn).toHaveBeenCalledWith("/custom/models");
  });
});
