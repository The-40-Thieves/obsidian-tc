// THE-388 — bge-m3 vLLM encoder client. Unit-tested with a fetch mock (no live vLLM in CI); the
// /pooling + /tokenize response shapes are assumptions to confirm against a running server.
import { describe, expect, it } from "vitest";
import { bgeM3VllmEncode, pairSparse } from "../src/embeddings/bge-m3";
import type { FetchFn } from "../src/embeddings/http";

function mockFetch(byKey: Record<string, unknown>): FetchFn {
  return (async (url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as { task?: string };
    const key = url.endsWith("/embeddings")
      ? "embeddings"
      : url.endsWith("/tokenize")
        ? "tokenize"
        : `pooling:${body.task}`;
    return new Response(JSON.stringify(byKey[key] ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as FetchFn;
}

describe("bge-m3 vLLM encoder (THE-388)", () => {
  it("pairSparse dedups a repeated token id to its max weight and drops non-positive", () => {
    expect(pairSparse([1, 2, 1], [0.3, 0.5, 0.8])).toEqual({ "1": 0.8, "2": 0.5 });
    expect(pairSparse([1, 2], [0, -1])).toEqual({});
    expect(pairSparse([], [])).toEqual({});
  });

  it("encodes dense + sparse + colbert from the vLLM endpoints", async () => {
    const fetchFn = mockFetch({
      embeddings: { data: [{ embedding: [0.1, 0.2, 0.3] }] },
      "pooling:token_classify": { data: [{ data: [0.9, 0.0, 0.5] }] },
      tokenize: { tokens: [101, 202, 303] },
      "pooling:token_embed": {
        data: [
          {
            data: [
              [1, 0],
              [0, 1],
              [1, 1],
            ],
          },
        ],
      },
    });
    const out = await bgeM3VllmEncode(["hello world"], { baseUrl: "http://x/v1", fetchFn });
    expect(out[0]?.dense).toEqual([0.1, 0.2, 0.3]);
    // token 101 -> 0.9, 202 -> 0.0 (dropped), 303 -> 0.5.
    expect(out[0]?.sparse).toEqual({ "101": 0.9, "303": 0.5 });
    expect(out[0]?.colbert).toEqual([
      [1, 0],
      [0, 1],
      [1, 1],
    ]);
  });

  it("returns [] for no input", async () => {
    expect(await bgeM3VllmEncode([], { baseUrl: "http://x/v1", fetchFn: mockFetch({}) })).toEqual(
      [],
    );
  });
});
