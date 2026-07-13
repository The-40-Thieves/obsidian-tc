import { describe, expect, it } from "vitest";
import type { FetchFn } from "../src/embeddings/http";
import { bgeModelClient, composeModelClient, teiModelClient } from "../src/model";

// A fetch that answers the BGE-M3 service's /v1/encode from a fixture, recording each request so the
// adapter's request shape (endpoint, outputs, auth header) can be asserted. No live server, no models.
function fakeBge(cfg: {
  items: (text: string) => {
    dense?: number[];
    sparse?: { token_ids: number[]; weights: number[] };
    colbert?: { vectors: number[][] };
  };
  model?: string;
  revision?: string;
  calls?: Array<{ url: string; body?: unknown; auth?: string }>;
}): FetchFn {
  const fn = async (
    input: unknown,
    init?: { body?: unknown; headers?: Record<string, string> },
  ) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as { input: string[]; outputs: string[] };
    cfg.calls?.push({
      url,
      body,
      auth: (init?.headers as Record<string, string> | undefined)?.authorization,
    });
    const items = body.input.map((t) => cfg.items(t));
    return new Response(
      JSON.stringify({
        model: cfg.model ?? "BAAI/bge-m3",
        revision: cfg.revision ?? "sha1",
        items,
      }),
      { status: 200 },
    );
  };
  return fn as unknown as FetchFn;
}

describe("bgeModelClient (ModelClient multi-vector adapter)", () => {
  it("embedFull posts all three outputs and zips sparse token_ids/weights into a SparseVec", async () => {
    const calls: Array<{ url: string; body?: unknown; auth?: string }> = [];
    const mc = bgeModelClient({
      baseUrl: "http://bge:8002/",
      dimensions: 2,
      authToken: "tok",
      fetchFn: fakeBge({
        items: (t) => ({
          dense: t === "a" ? [1, 0] : [0, 1],
          sparse: { token_ids: [101, 250], weights: [0.7, 0.3] },
          colbert: {
            vectors: [
              [1, 0],
              [0, 1],
            ],
          },
        }),
        calls,
      }),
    });
    const r = await mc.embedFull?.({ texts: ["a", "b"] });
    expect(r?.model).toBe("BAAI/bge-m3");
    expect(r?.revision).toBe("sha1");
    expect(r?.items).toHaveLength(2);
    // whole-object deep-equal: token_ids become string keys aligned with their weights.
    expect(r?.items[0]).toEqual({
      dense: [1, 0],
      sparse: { "101": 0.7, "250": 0.3 },
      colbert: [
        [1, 0],
        [0, 1],
      ],
    });
    expect(calls[0]?.url).toBe("http://bge:8002/v1/encode");
    expect(calls[0]?.body).toMatchObject({ outputs: ["dense", "sparse", "colbert"] });
    expect(calls[0]?.auth).toBe("Bearer tok");
  });

  it("embed asks for only the dense head and returns vectors in request order", async () => {
    const calls: Array<{ url: string; body?: unknown; auth?: string }> = [];
    const mc = bgeModelClient({
      baseUrl: "http://bge:8002",
      dimensions: 2,
      fetchFn: fakeBge({ items: (t) => ({ dense: t === "a" ? [1, 0] : [0, 1] }), calls }),
    });
    const r = await mc.embed({ texts: ["a", "b"] });
    expect(r.vectors).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(r.pooling).toBe("cls");
    expect(calls[0]?.body).toMatchObject({ outputs: ["dense"] });
  });

  it("short-circuits empty input without a network call, using config-pinned provenance", async () => {
    let called = false;
    const mc = bgeModelClient({
      baseUrl: "http://bge:8002",
      dimensions: 2,
      model: "BAAI/bge-m3",
      revision: "pinned",
      fetchFn: (() => {
        called = true;
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as unknown as FetchFn,
    });
    const full = await mc.embedFull?.({ texts: [] });
    expect(full?.items).toEqual([]);
    expect(full?.revision).toBe("pinned");
    expect(called).toBe(false);
  });

  it("stops at the shorter of token_ids/weights rather than misaligning a corrupt sparse response", async () => {
    const mc = bgeModelClient({
      baseUrl: "http://bge:8002",
      dimensions: 2,
      fetchFn: fakeBge({
        items: () => ({ dense: [1, 0], sparse: { token_ids: [1, 2, 3], weights: [0.5] } }),
      }),
    });
    const r = await mc.embedFull?.({ texts: ["a"] });
    expect(r?.items[0]).toEqual({ dense: [1, 0], sparse: { "1": 0.5 }, colbert: [] });
  });
});

describe("composeModelClient (fan methods to their owning backend)", () => {
  it("routes embed -> dense (Qwen) and embedFull -> full (BGE), each its own vector space", async () => {
    const dense = teiModelClient({
      baseUrl: "http://tei:8080",
      dimensions: 2,
      model: "Qwen/Qwen3-Embedding-0.6B",
      fetchFn: (async (input: unknown, init?: { body?: unknown }) => {
        const url = String(input);
        if (url.endsWith("/info")) return new Response("{}", { status: 200 });
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        return new Response(
          JSON.stringify({
            data: body.input.map((_t, index) => ({ embedding: [9, 9], index })),
            model: "Qwen/Qwen3-Embedding-0.6B",
          }),
          { status: 200 },
        );
      }) as unknown as FetchFn,
    });
    const full = bgeModelClient({
      baseUrl: "http://bge:8002",
      dimensions: 2,
      fetchFn: fakeBge({
        items: () => ({ dense: [1, 1], sparse: { token_ids: [5], weights: [0.9] } }),
      }),
    });
    const mc = composeModelClient({ dense, full });

    const e = await mc.embed({ texts: ["q"] });
    expect(e.vectors).toEqual([[9, 9]]);
    expect(e.model).toBe("Qwen/Qwen3-Embedding-0.6B");

    const f = await mc.embedFull?.({ texts: ["q"] });
    expect(f?.items[0]).toEqual({ dense: [1, 1], sparse: { "5": 0.9 }, colbert: [] });
  });

  it("omits embedFull and rerank when no backend provides them (dense-only deployment)", () => {
    const dense = bgeModelClient({ baseUrl: "http://x", dimensions: 2 });
    const denseOnly = { embed: dense.embed };
    const mc = composeModelClient({ dense: denseOnly });
    expect(mc.embedFull).toBeUndefined();
    expect(mc.rerank).toBeUndefined();
  });
});
