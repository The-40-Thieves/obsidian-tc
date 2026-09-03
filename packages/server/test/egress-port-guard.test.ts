// THE-934 fix round 2 (N1, blocking) — the port guard itself had NO test: round 1's fix1-review
// deleted both factory wraps (`gateway/client.ts`'s `guardGatewayClient` call and
// `embeddings/index.ts`'s `withEgressGuard` call) and the entire egress test surface stayed green,
// 15 files / 159 tests. Every existing test adapted its fixtures to SATISFY the guard; none
// asserted the guard actually fires. This file is that assertion, built directly against the REAL
// factories (`createGatewayClient`, `createEmbeddingProvider`, `createEmbeddingProviderAsync`) with
// a COUNTING fake transport, so a regression that drops either wrap shows up as a call count that
// should be 0 but isn't -- not merely as a thrown error a looser assertion could paper over.
//
// Four cases per content-bearing method, on both ports:
//   (a) sourcePaths undefined      -> throws EgressViolationError, transport sees ZERO calls
//   (b) sourcePaths has an excluded path -> throws EgressViolationError, transport sees ZERO calls
//   (c) sourcePaths: []            -> passes, transport sees exactly one call (fix round 1, I1)
//   (d) sourcePaths: [non-excluded] -> passes, transport sees exactly one call
import { describe, expect, it } from "vitest";
import { createEmbeddingProvider, createEmbeddingProviderAsync } from "../src/embeddings";
import type { FetchFn } from "../src/embeddings/http";
import { createGatewayClient } from "../src/gateway/client";
import { compileEgressFilter } from "../src/plane/egress-filter";
import { EgressViolationError } from "../src/plane/egress-guard";
import { resolveReranker } from "../src/providers/registry";

const FILTER = compileEgressFilter(["Private/**"]);

function countingFetch(): { fetchFn: typeof fetch; state: { calls: number } } {
  const state = { calls: 0 };
  const fetchFn = (async (url: string) => {
    state.calls += 1;
    if (String(url).endsWith("/rerank")) {
      return new Response(
        JSON.stringify({ model: "m", results: [{ index: 0, relevance_score: 0.9 }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ model: "m", choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, state };
}

describe("gateway port guard (THE-934 fix round 2, N1) — createGatewayClient", () => {
  const methods: Array<
    [
      "extract" | "synthesize" | "judge",
      (c: ReturnType<typeof createGatewayClient>, sp?: string[]) => Promise<unknown>,
    ]
  > = [
    [
      "extract",
      (c, sp) =>
        c.extract({
          messages: [{ role: "user", content: "x" }],
          ...(sp !== undefined ? { sourcePaths: sp } : {}),
        }),
    ],
    [
      "synthesize",
      (c, sp) =>
        c.synthesize({
          messages: [{ role: "user", content: "x" }],
          ...(sp !== undefined ? { sourcePaths: sp } : {}),
        }),
    ],
    [
      "judge",
      (c, sp) =>
        c.judge({
          messages: [{ role: "user", content: "x" }],
          ...(sp !== undefined ? { sourcePaths: sp } : {}),
        }),
    ],
  ];

  for (const [name, call] of methods) {
    it(`${name}: undeclared sourcePaths throws, zero transport calls`, async () => {
      const { fetchFn, state } = countingFetch();
      const client = createGatewayClient({ baseUrl: "http://gw", fetchFn, excludeFilter: FILTER });
      await expect(call(client)).rejects.toBeInstanceOf(EgressViolationError);
      expect(state.calls).toBe(0);
    });

    it(`${name}: an excluded path in sourcePaths throws, zero transport calls`, async () => {
      const { fetchFn, state } = countingFetch();
      const client = createGatewayClient({ baseUrl: "http://gw", fetchFn, excludeFilter: FILTER });
      await expect(call(client, ["Private/secret.md"])).rejects.toBeInstanceOf(
        EgressViolationError,
      );
      expect(state.calls).toBe(0);
    });

    it(`${name}: a declared-empty sourcePaths passes, exactly one transport call`, async () => {
      const { fetchFn, state } = countingFetch();
      const client = createGatewayClient({ baseUrl: "http://gw", fetchFn, excludeFilter: FILTER });
      await expect(call(client, [])).resolves.toBeDefined();
      expect(state.calls).toBe(1);
    });

    it(`${name}: a non-excluded declared path passes, exactly one transport call`, async () => {
      const { fetchFn, state } = countingFetch();
      const client = createGatewayClient({ baseUrl: "http://gw", fetchFn, excludeFilter: FILTER });
      await expect(call(client, ["Public/a.md"])).resolves.toBeDefined();
      expect(state.calls).toBe(1);
    });
  }

  it("rerank: undeclared sourcePaths throws, zero transport calls", async () => {
    const { fetchFn, state } = countingFetch();
    const client = createGatewayClient({ baseUrl: "http://gw", fetchFn, excludeFilter: FILTER });
    await expect(
      client.rerank({ query: "q", documents: ["a", "b"], topN: 2 }),
    ).rejects.toBeInstanceOf(EgressViolationError);
    expect(state.calls).toBe(0);
  });

  it("rerank: an excluded path in sourcePaths throws, zero transport calls", async () => {
    const { fetchFn, state } = countingFetch();
    const client = createGatewayClient({ baseUrl: "http://gw", fetchFn, excludeFilter: FILTER });
    await expect(
      client.rerank({
        query: "q",
        documents: ["a", "b"],
        topN: 2,
        sourcePaths: ["Public/a.md", "Private/b.md"],
      }),
    ).rejects.toBeInstanceOf(EgressViolationError);
    expect(state.calls).toBe(0);
  });

  it("rerank: a declared, non-excluded sourcePaths passes, exactly one transport call", async () => {
    const { fetchFn, state } = countingFetch();
    const client = createGatewayClient({ baseUrl: "http://gw", fetchFn, excludeFilter: FILTER });
    const r = await client.rerank({
      query: "q",
      documents: ["a", "b"],
      topN: 2,
      sourcePaths: ["Public/a.md", "Public/b.md"],
    });
    expect(r.results).toHaveLength(1);
    expect(state.calls).toBe(1);
  });

  it("ping never requires sourcePaths — a liveness probe carries no content", async () => {
    const { fetchFn, state } = countingFetch();
    const client = createGatewayClient({ baseUrl: "http://gw", fetchFn, excludeFilter: FILTER });
    await expect(client.ping()).resolves.toBe(true);
    expect(state.calls).toBe(1);
  });

  it("with NO excludeFilter configured at all, the declaration requirement still applies", async () => {
    const { fetchFn, state } = countingFetch();
    const client = createGatewayClient({ baseUrl: "http://gw", fetchFn });
    await expect(
      client.judge({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBeInstanceOf(EgressViolationError);
    expect(state.calls).toBe(0);
  });
});

describe("embedding port guard (THE-934 fix round 2, N1) — createEmbeddingProvider(Async)", () => {
  const CFG = { provider: "ollama", model: "nomic-embed-text", dimensions: 3 } as const;

  function embedFetch(): { fetchFn: FetchFn; state: { calls: number } } {
    const state = { calls: 0 };
    const inner = (async () =>
      new Response(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as FetchFn;
    const fetchFn = (async (...args: Parameters<FetchFn>) => {
      state.calls += 1;
      return inner(...args);
    }) as FetchFn;
    return { fetchFn, state };
  }

  it("embed (sync factory): undeclared sourcePaths throws, zero transport calls", async () => {
    const { fetchFn, state } = embedFetch();
    const p = createEmbeddingProvider(CFG, { fetchFn, excludeFilter: FILTER });
    await expect(p.embed(["hello"])).rejects.toBeInstanceOf(EgressViolationError);
    expect(state.calls).toBe(0);
  });

  it("embed (sync factory): an excluded sourcePaths throws, zero transport calls", async () => {
    const { fetchFn, state } = embedFetch();
    const p = createEmbeddingProvider(CFG, { fetchFn, excludeFilter: FILTER });
    await expect(p.embed(["hello"], { sourcePaths: ["Private/secret.md"] })).rejects.toBeInstanceOf(
      EgressViolationError,
    );
    expect(state.calls).toBe(0);
  });

  it("embed (sync factory): declared-empty sourcePaths passes, exactly one transport call", async () => {
    const { fetchFn, state } = embedFetch();
    const p = createEmbeddingProvider(CFG, { fetchFn, excludeFilter: FILTER });
    await expect(p.embed(["hello"], { sourcePaths: [] })).resolves.toEqual([[0.1, 0.2, 0.3]]);
    expect(state.calls).toBe(1);
  });

  it("embed (sync factory): a non-excluded declared path passes, exactly one transport call", async () => {
    const { fetchFn, state } = embedFetch();
    const p = createEmbeddingProvider(CFG, { fetchFn, excludeFilter: FILTER });
    await expect(p.embed(["hello"], { sourcePaths: ["Public/a.md"] })).resolves.toEqual([
      [0.1, 0.2, 0.3],
    ]);
    expect(state.calls).toBe(1);
  });

  it("embed: input:'query' is exempt regardless of sourcePaths (never vault content)", async () => {
    const { fetchFn, state } = embedFetch();
    const p = createEmbeddingProvider(CFG, { fetchFn, excludeFilter: FILTER });
    await expect(p.embed(["a query"], { input: "query" })).resolves.toEqual([[0.1, 0.2, 0.3]]);
    expect(state.calls).toBe(1);
  });

  it("embed: with NO excludeFilter configured, the declaration requirement still applies", async () => {
    const { fetchFn, state } = embedFetch();
    const p = createEmbeddingProvider(CFG, { fetchFn });
    await expect(p.embed(["hello"])).rejects.toBeInstanceOf(EgressViolationError);
    expect(state.calls).toBe(0);
  });

  it("embed (async factory, createEmbeddingProviderAsync): undeclared sourcePaths throws, zero calls", async () => {
    const { fetchFn, state } = embedFetch();
    const p = await createEmbeddingProviderAsync(CFG, { fetchFn, excludeFilter: FILTER });
    await expect(p.embed(["hello"])).rejects.toBeInstanceOf(EgressViolationError);
    expect(state.calls).toBe(0);
  });

  it("embed (async factory): an excluded sourcePaths throws, zero transport calls", async () => {
    const { fetchFn, state } = embedFetch();
    const p = await createEmbeddingProviderAsync(CFG, { fetchFn, excludeFilter: FILTER });
    await expect(p.embed(["hello"], { sourcePaths: ["Private/secret.md"] })).rejects.toBeInstanceOf(
      EgressViolationError,
    );
    expect(state.calls).toBe(0);
  });

  it("embed (async factory): a non-excluded declared path passes, exactly one transport call", async () => {
    const { fetchFn, state } = embedFetch();
    const p = await createEmbeddingProviderAsync(CFG, { fetchFn, excludeFilter: FILTER });
    await expect(p.embed(["hello"], { sourcePaths: ["Public/a.md"] })).resolves.toEqual([
      [0.1, 0.2, 0.3],
    ]);
    expect(state.calls).toBe(1);
  });

  it("embedFull (bge-m3, sync factory): undeclared sourcePaths throws, zero transport calls", async () => {
    let calls = 0;
    const fetchFn = (async (url: string, init?: { body?: string }) => {
      calls += 1;
      const body = JSON.parse(init?.body ?? "{}") as { task?: string };
      const key = url.endsWith("/embeddings")
        ? "embeddings"
        : url.endsWith("/tokenize")
          ? "tokenize"
          : `pooling:${body.task}`;
      const byKey: Record<string, unknown> = {
        embeddings: { data: [{ embedding: [0.1, 0.2, 0.3] }] },
        "pooling:token_classify": { data: [{ data: [0.9, 0.5] }] },
        tokenize: { tokens: [7, 8] },
        "pooling:token_embed": {
          data: [
            {
              data: [
                [1, 0],
                [0, 1],
              ],
            },
          ],
        },
      };
      return new Response(JSON.stringify(byKey[key] ?? {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as FetchFn;
    const p = createEmbeddingProvider(
      { provider: "bge-m3", model: "BAAI/bge-m3", dimensions: 3, baseUrl: "http://x/v1" },
      { fetchFn, excludeFilter: FILTER },
    );
    await expect(p.embedFull?.(["hello"])).rejects.toBeInstanceOf(EgressViolationError);
    expect(calls).toBe(0);
  });

  it("embedFull (bge-m3): a non-excluded declared path passes, real calls happen", async () => {
    let calls = 0;
    const fetchFn = (async (url: string, init?: { body?: string }) => {
      calls += 1;
      const body = JSON.parse(init?.body ?? "{}") as { task?: string };
      const key = url.endsWith("/embeddings")
        ? "embeddings"
        : url.endsWith("/tokenize")
          ? "tokenize"
          : `pooling:${body.task}`;
      const byKey: Record<string, unknown> = {
        embeddings: { data: [{ embedding: [0.1, 0.2, 0.3] }] },
        "pooling:token_classify": { data: [{ data: [0.9, 0.5] }] },
        tokenize: { tokens: [7, 8] },
        "pooling:token_embed": {
          data: [
            {
              data: [
                [1, 0],
                [0, 1],
              ],
            },
          ],
        },
      };
      return new Response(JSON.stringify(byKey[key] ?? {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as FetchFn;
    const p = createEmbeddingProvider(
      { provider: "bge-m3", model: "BAAI/bge-m3", dimensions: 3, baseUrl: "http://x/v1" },
      { fetchFn, excludeFilter: FILTER },
    );
    const [out] = (await p.embedFull?.(["hello"], { sourcePaths: ["Public/a.md"] })) ?? [];
    expect(out?.dense).toEqual([0.1, 0.2, 0.3]);
    expect(calls).toBeGreaterThan(0);
  });
});

describe("reranker port guard (THE-934 fix round 2, N3) — resolveReranker", () => {
  function rerankFetch(): { fetchFn: FetchFn; state: { calls: number } } {
    const state = { calls: 0 };
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({ model: "rerank-v3.5", results: [{ index: 0, relevance_score: 0.7 }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as FetchFn;
    return {
      fetchFn: (async (...args: Parameters<FetchFn>) => {
        state.calls += 1;
        return fetchFn(...args);
      }) as FetchFn,
      state,
    };
  }

  const CFG = {
    provider: "cohere-compatible",
    model: "rerank-v3.5",
    baseUrl: "http://rerank.invalid/v2",
  };

  it("undeclared sourcePaths throws, zero transport calls", async () => {
    const { fetchFn, state } = rerankFetch();
    const reranker = await resolveReranker(CFG, { fetchFn, excludeFilter: FILTER });
    expect(reranker).not.toBeNull();
    await expect(
      reranker?.("q", ["a", "b"], 2, undefined as unknown as string[]),
    ).rejects.toBeInstanceOf(EgressViolationError);
    expect(state.calls).toBe(0);
  });

  it("an excluded path in sourcePaths throws, zero transport calls", async () => {
    const { fetchFn, state } = rerankFetch();
    const reranker = await resolveReranker(CFG, { fetchFn, excludeFilter: FILTER });
    await expect(
      reranker?.("q", ["a", "b"], 2, ["Public/a.md", "Private/b.md"]),
    ).rejects.toBeInstanceOf(EgressViolationError);
    expect(state.calls).toBe(0);
  });

  it("declared-empty sourcePaths passes, exactly one transport call", async () => {
    const { fetchFn, state } = rerankFetch();
    const reranker = await resolveReranker(CFG, { fetchFn, excludeFilter: FILTER });
    const hits = await reranker?.("q", ["a", "b"], 2, []);
    expect(hits).toHaveLength(1);
    expect(state.calls).toBe(1);
  });

  it("a non-excluded declared sourcePaths passes, exactly one transport call", async () => {
    const { fetchFn, state } = rerankFetch();
    const reranker = await resolveReranker(CFG, { fetchFn, excludeFilter: FILTER });
    const hits = await reranker?.("q", ["a", "b"], 2, ["Public/a.md", "Public/b.md"]);
    expect(hits).toHaveLength(1);
    expect(state.calls).toBe(1);
  });

  it("with NO excludeFilter configured at all, the declaration requirement still applies", async () => {
    const { fetchFn, state } = rerankFetch();
    const reranker = await resolveReranker(CFG, { fetchFn });
    await expect(
      reranker?.("q", ["a", "b"], 2, undefined as unknown as string[]),
    ).rejects.toBeInstanceOf(EgressViolationError);
    expect(state.calls).toBe(0);
  });
});
