// THE-388 — bge-m3 vLLM encoder client, updated to the LIVE-VERIFIED shapes (THE-395,
// 2026-07-11): /pooling + /tokenize live at the server root (not /v1), /tokenize takes
// { model, prompt } per text, and a pooling task the server does not expose degrades that head
// to empty instead of failing the encode (memoized per server+task, so each test uses its own
// fake base URL).
import { describe, expect, it } from "vitest";
import { bgeM3VllmEncode, pairSparse } from "../src/embeddings/bge-m3";
import type { FetchFn } from "../src/embeddings/http";

function mockFetch(
  byKey: Record<string, unknown>,
  log?: Array<{ url: string; body: Record<string, unknown> }>,
): FetchFn {
  return (async (url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as { task?: string } & Record<string, unknown>;
    log?.push({ url, body });
    const key = url.endsWith("/embeddings")
      ? "embeddings"
      : url.endsWith("/tokenize")
        ? "tokenize"
        : "pooling:" + body.task;
    const payload = byKey[key];
    if (payload === undefined) {
      return new Response(JSON.stringify({ error: { message: "Unsupported task" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as FetchFn;
}

describe("bge-m3 vLLM encoder (THE-388 / THE-395 shapes)", () => {
  it("pairSparse dedups a repeated token id to its max weight and drops non-positive", () => {
    expect(pairSparse([1, 2, 1], [0.3, 0.5, 0.8])).toEqual({ "1": 0.8, "2": 0.5 });
    expect(pairSparse([1, 2], [0, -1])).toEqual({});
    expect(pairSparse([], [])).toEqual({});
  });

  it("encodes dense + sparse + colbert (root pooling, prompt tokenize)", async () => {
    const log: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchFn = mockFetch(
      {
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
      },
      log,
    );
    const out = await bgeM3VllmEncode(["hello world"], { baseUrl: "http://full/v1", fetchFn });
    expect(out[0]?.dense).toEqual([0.1, 0.2, 0.3]);
    // token 101 -> 0.9, 202 -> 0.0 (dropped), 303 -> 0.5.
    expect(out[0]?.sparse).toEqual({ "101": 0.9, "303": 0.5 });
    expect(out[0]?.colbert).toEqual([
      [1, 0],
      [0, 1],
      [1, 1],
    ]);
    // Live-verified surface: /embeddings under /v1; /pooling + /tokenize at the root;
    // /tokenize carries { prompt }, not { input }.
    expect(log.find((l) => l.url.endsWith("/embeddings"))?.url).toBe("http://full/v1/embeddings");
    expect(log.filter((l) => l.url === "http://full/pooling")).toHaveLength(2);
    const tok = log.find((l) => l.url === "http://full/tokenize");
    expect(tok?.body.prompt).toBe("hello world");
  });

  it("degrades an unsupported pooling task to an empty head instead of failing", async () => {
    // token_classify missing from the mock -> 400 -> sparse {} while dense + colbert survive.
    const fetchFn = mockFetch({
      embeddings: { data: [{ embedding: [0.5, 0.5] }] },
      "pooling:token_embed": { data: [{ data: [[1, 0]] }] },
    });
    const out = await bgeM3VllmEncode(["only dense and colbert"], {
      baseUrl: "http://nosparse/v1",
      fetchFn,
    });
    expect(out[0]?.dense).toEqual([0.5, 0.5]);
    expect(out[0]?.sparse).toEqual({});
    expect(out[0]?.colbert).toEqual([[1, 0]]);
  });

  it("memoizes an unsupported task per server so later encodes skip the failing call", async () => {
    const log: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchFn = mockFetch(
      {
        embeddings: { data: [{ embedding: [1, 0] }] },
        "pooling:token_embed": { data: [{ data: [[1, 0]] }] },
      },
      log,
    );
    await bgeM3VllmEncode(["first"], { baseUrl: "http://memo/v1", fetchFn });
    await bgeM3VllmEncode(["second"], { baseUrl: "http://memo/v1", fetchFn });
    const classifyCalls = log.filter((l) => l.body.task === "token_classify");
    expect(classifyCalls).toHaveLength(1); // second encode skipped the known-bad task
  });

  it("returns [] for no input", async () => {
    expect(await bgeM3VllmEncode([], { baseUrl: "http://x/v1", fetchFn: mockFetch({}) })).toEqual(
      [],
    );
  });
});
