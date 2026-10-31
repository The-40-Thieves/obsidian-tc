// Stubbed-inference-fn tests — exercise createReranker's tokenize -> model -> rank wiring with a
// fake Session, so this always runs (no @huggingface/transformers, no model weights needed).
import { availableParallelism } from "node:os";
import { describe, expect, it, vi } from "vitest";
import * as rerankerModule from "../src/index.js";
import { createReranker, rerankModelOptions, type Session } from "../src/index.js";

function stubSession(logitsByDoc: number[]): Session {
  const tokenizer = vi.fn((_queries: string[], _opts: unknown) => ({ input_ids: [] }));
  const model = vi.fn(async (_inputs: unknown) => ({ logits: { data: logitsByDoc } }));
  return { tokenizer, model };
}

describe("configureTransformersEnvForOnnxBackend", () => {
  it("disables Transformers' WASM cache only when the selected backend is wasm", () => {
    // Incident: Node rejected Transformers' generated module with
    // `Received protocol 'blob:'`; disabling useWasmCache bypasses that blob: import path.
    const configure = (
      rerankerModule as unknown as {
        configureTransformersEnvForOnnxBackend?: (
          env: { useWasmCache: boolean },
          backend: { backend: "native" | "wasm" },
        ) => void;
      }
    ).configureTransformersEnvForOnnxBackend;
    expect(configure).toBeTypeOf("function");
    const wasmEnv = { useWasmCache: true };
    configure?.(wasmEnv, { backend: "wasm" });
    expect(wasmEnv.useWasmCache).toBe(false);
    const nativeEnv = { useWasmCache: true };
    configure?.(nativeEnv, { backend: "native" });
    expect(nativeEnv.useWasmCache).toBe(true);
  });
});

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

describe("rerankModelOptions (GH #995 — the ACTUAL options loadSession hands to from_pretrained())", () => {
  it("caps intraOpNumThreads, sets interOpNumThreads:1, and disables spinning — no config knob here", () => {
    const opts = rerankModelOptions();
    expect(opts.session_options.intraOpNumThreads).toBe(
      Math.max(1, Math.floor(availableParallelism() / 4)),
    );
    expect(opts.session_options.interOpNumThreads).toBe(1);
    expect(opts.session_options.extra.session.intra_op.allow_spinning).toBe("0");
    expect(opts.session_options.extra.session.inter_op.allow_spinning).toBe("0");
    expect(opts.session_options.extra.session.disable_prepacking).toBe("1");
  });
});

// GH #1433: same native-buffer problem as the embedder. The reranker loads Transformers.js too, so
// its per-request logits tensor is native memory that tolist()/Array.from does not free. See the
// embedder's own dispose tests for the measurements.
describe("createReranker releases the logits tensor per request (GH #1433)", () => {
  function disposableSession(logitsByDoc: number[]) {
    const dispose = vi.fn();
    const tokenizer = vi.fn((_queries: string[], _opts: unknown) => ({ input_ids: [] }));
    const model = vi.fn(async (_inputs: unknown) => ({
      logits: { data: logitsByDoc, dispose },
    }));
    return { session: { tokenizer, model } as unknown as Session, dispose };
  }

  it("disposes the logits tensor after copying the scores out", async () => {
    const { session, dispose } = disposableSession([0.1, 0.9]);
    const reranker = createReranker({}, async () => session);
    const hits = await reranker("q", ["doc a", "doc b"], 2);
    expect(hits).toHaveLength(2);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes once per rerank call", async () => {
    const { session, dispose } = disposableSession([0.5]);
    const reranker = createReranker({}, async () => session);
    await reranker("q", ["doc"], 1);
    await reranker("q", ["doc"], 1);
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("still ranks when the logits tensor predates dispose()", async () => {
    const session = {
      tokenizer: vi.fn(() => ({})),
      model: vi.fn(async () => ({ logits: { data: [0.3] } })),
    };
    const reranker = createReranker({}, async () => session as unknown as Session);
    await expect(reranker("q", ["doc"], 1)).resolves.toHaveLength(1);
  });

  it("disposes the logits tensor even when reading the scores out throws", async () => {
    const dispose = vi.fn();
    const tokenizer = vi.fn((_queries: string[], _opts: unknown) => ({ input_ids: [] }));
    // A logits object that carries dispose() but whose data accessor fails — what an invalidated or
    // wedged ORT output looks like from here. Without the finally, this is the one path that leaks
    // the native buffer, and a broken model takes it on every call. Mirrors the embedder's
    // "disposes even when the vector-count check throws" case.
    const model = vi.fn(async (_inputs: unknown) => ({
      logits: {
        get data(): number[] {
          throw new Error("logits buffer unavailable");
        },
        dispose,
      },
    }));
    const session = { tokenizer, model } as unknown as Session;
    const reranker = createReranker({}, async () => session);
    await expect(reranker("q", ["doc"], 1)).rejects.toThrow("logits buffer unavailable");
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
