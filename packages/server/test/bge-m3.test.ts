// THE-388 — bge-m3 vLLM encoder client, updated to the LIVE-VERIFIED shapes (THE-395,
// 2026-07-11): /pooling + /tokenize live at the server root (not /v1), /tokenize takes
// { model, prompt } per text, and a pooling task the server does not expose degrades that head
// to empty instead of failing the encode (memoized per server+task, so each test uses its own
// fake base URL).
import { describe, expect, it } from "vitest";
import { alignTokensToScores, bgeM3VllmEncode, pairSparse } from "../src/embeddings/bge-m3";
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
        : `pooling:${body.task}`;
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
    expect(pairSparse([100, 200, 100], [0.3, 0.5, 0.8])).toEqual({ "100": 0.8, "200": 0.5 });
    expect(pairSparse([100, 200], [0, -1])).toEqual({});
    expect(pairSparse([], [])).toEqual({});
  });

  it("pairSparse drops XLM-R special tokens (<s>/<pad>/</s>/<unk>) even at positive weight", () => {
    // The FlagEmbedding lexical_weights contract: cls/eos/pad/unk never enter the sparse
    // vector — otherwise every query matches every document on the cls key.
    expect(pairSparse([0, 1, 2, 3, 777], [0.9, 0.9, 0.9, 0.9, 0.4])).toEqual({ "777": 0.4 });
  });

  it("alignTokensToScores handles full, BOS/EOS-stripped, and mismatched score lists", () => {
    // equal lengths: pair directly
    expect(alignTokensToScores([0, 10, 20, 2], [1, 2, 3, 4])).toEqual([0, 10, 20, 2]);
    // vLLM BgeM3 pooler strips BOS/EOS from scores: pair against the inner ids
    expect(alignTokensToScores([0, 10, 20, 2], [0.5, 0.6])).toEqual([10, 20]);
    // anything else is a hard mismatch: degrade, never truncate (weight-shift corruption)
    expect(alignTokensToScores([0, 10, 20, 2], [0.5])).toBeNull();
    expect(alignTokensToScores([0, 10, 2], [0.1, 0.2, 0.3, 0.4])).toBeNull();
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

  it("does NOT memoize a transient (5xx) pooling error — retries on the next encode (B1)", async () => {
    let classifyCalls = 0;
    const fetchFn = (async (url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as { task?: string };
      if (url.endsWith("/embeddings"))
        return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), { status: 200 });
      if (url.endsWith("/tokenize"))
        return new Response(JSON.stringify({ tokens: [101] }), { status: 200 });
      if (body.task === "token_classify") {
        classifyCalls += 1;
        // first batch: a transient 503 (GPU busy); second batch: success.
        return classifyCalls === 1
          ? new Response(JSON.stringify({ error: "busy" }), { status: 503 })
          : new Response(JSON.stringify({ data: [{ data: [0.7] }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unsupported" }), { status: 400 });
    }) as unknown as FetchFn;

    // transient failure degrades THIS batch to empty — but must NOT poison the head.
    const first = await bgeM3VllmEncode(["a"], { baseUrl: "http://transient/v1", fetchFn });
    expect(first[0]?.sparse).toEqual({});
    // next batch retries the head (not permanently disabled) and now succeeds.
    const second = await bgeM3VllmEncode(["a"], { baseUrl: "http://transient/v1", fetchFn });
    expect(second[0]?.sparse).toEqual({ "101": 0.7 });
    expect(classifyCalls).toBe(2); // retried, not skipped
  });

  it("returns [] for no input", async () => {
    expect(await bgeM3VllmEncode([], { baseUrl: "http://x/v1", fetchFn: mockFetch({}) })).toEqual(
      [],
    );
  });
});
