// A caller deadline must reach every leg of a provider call. Two legs were missed: the
// post-completion /model/info provenance lookup (it had only its own five-second timer, so a
// finished judge call followed by a stalled lookup outlived the caller's deadline) and
// GatewayClient.rerank (no signal parameter at all, so a Retry-After backoff could not be cancelled).
import { describe, expect, it } from "vitest";
import { createGatewayClient } from "../src/gateway/client";
import { rerankWithScores } from "../src/search/rerank";

const completion = new Response(
  JSON.stringify({ model: "judge", choices: [{ message: { content: "ok" } }] }),
  { headers: { "content-type": "application/json", "x-litellm-model-id": "dep-1" } },
);

describe("caller abort reaches the whole gateway call", () => {
  it("cancels the /model/info lookup after a completed judge call", async () => {
    let infoSignal: AbortSignal | undefined;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/model/info")) {
        infoSignal = init?.signal ?? undefined;
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return completion.clone();
    }) as unknown as typeof fetch;
    const client = createGatewayClient({
      baseUrl: "http://127.0.0.1:1",
      fetchFn,
      timeoutMs: 60_000,
    });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 40);
    const t0 = Date.now();
    const out = await client.judge({
      messages: [{ role: "user", content: "x" }],
      sourcePaths: [],
      signal: ctrl.signal,
    });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(infoSignal?.aborted).toBe(true);
    // The completion itself succeeded; only the provenance lookup was cancelled.
    expect(out.text).toBe("ok");
  });

  it("rerank forwards a caller signal: a Retry-After backoff ends on abort", async () => {
    let fetches = 0;
    const fetchFn = (async () => {
      fetches++;
      return new Response("{}", { status: 429, headers: { "retry-after": "60" } });
    }) as unknown as typeof fetch;
    const client = createGatewayClient({
      baseUrl: "http://127.0.0.1:1",
      fetchFn,
      timeoutMs: 60_000,
    });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 40);
    const t0 = Date.now();
    await expect(
      client.rerank({ query: "q", documents: ["a"], sourcePaths: [], signal: ctrl.signal }),
    ).rejects.toBeDefined();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(fetches).toBe(1);
  });

  it("rerankWithScores hands the reranker a signal that fires when its own timeout does", async () => {
    let seen: AbortSignal | undefined;
    const reranker = (
      _q: string,
      _d: string[],
      _n: number,
      _p: string[],
      signal?: AbortSignal,
    ): Promise<{ index: number; relevanceScore: number }[]> => {
      seen = signal;
      return new Promise(() => undefined);
    };
    const outcomes: string[] = [];
    await rerankWithScores(
      "q",
      [{ content: "a", path: "a.md" }],
      1,
      reranker,
      (o) => outcomes.push(o),
      30,
    );
    expect(outcomes).toEqual(["timed_out"]);
    expect(seen?.aborted).toBe(true);
  });
});
