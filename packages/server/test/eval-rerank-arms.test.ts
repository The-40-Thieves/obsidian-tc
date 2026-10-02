// Reranker-arms eval: the ordering rules every arm is scored through (eval/rerank-arms-lib.ts) and
// the adapters' wire shapes (eval/rerank-adapters.ts). A wrong tie rule or a dropped candidate here
// would move every arm's number, so each rule is pinned on a tiny pool. No network: fetch is stubbed.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoldenQuery } from "../eval/metrics";
import {
  cloudflareBgeReranker,
  deepInfraQwen3Reranker,
  nvidiaNemotronReranker,
  openRouterReranker,
  PUBLIC_ONLY_ARMS,
  RerankHttpError,
  throttled,
} from "../eval/rerank-adapters";
import {
  bhDecisions,
  corpusVerdict,
  denseOrder,
  estimateNeurons,
  gatedOrder,
  hopClass,
  type Pool,
  percentile,
  rerankOrder,
  rrfFuseOrder,
  summarizePaired,
  truncatePool,
} from "../eval/rerank-arms-lib";

const pool: Pool = {
  id: "q",
  query_text: "x",
  route_class: "standard",
  candidates: ["a", "b", "c", "d"].map((p) => ({ chunk_id: `c-${p}`, path: `${p}.md`, text: p })),
};
const paths = (xs: Array<{ path: string }>): string[] => xs.map((x) => x.path);

describe("orderings over one pool", () => {
  it("dense order is the pool as retrieved; truncation keeps the head", () => {
    expect(paths(denseOrder(pool))).toEqual(["a.md", "b.md", "c.md", "d.md"]);
    expect(paths(denseOrder(truncatePool(pool, 2)))).toEqual(["a.md", "b.md"]);
  });

  it("rerank order sorts by descending score and breaks ties by dense rank", () => {
    const o = rerankOrder(pool, [
      { index: 0, score: 0.2 },
      { index: 1, score: 0.9 },
      { index: 2, score: 0.2 },
      { index: 3, score: 0.5 },
    ]);
    expect(paths(o)).toEqual(["b.md", "d.md", "a.md", "c.md"]);
  });

  it("a candidate the provider did not score is appended in dense order, never dropped", () => {
    const o = rerankOrder(pool, [{ index: 2, score: 0.1 }]);
    expect(paths(o)).toEqual(["c.md", "a.md", "b.md", "d.md"]);
  });

  it("ignores out-of-range, non-finite and repeated indices", () => {
    const o = rerankOrder(pool, [
      { index: 9, score: 5 },
      { index: -1, score: 5 },
      { index: 1, score: Number.NaN },
      { index: 3, score: 0.3 },
      { index: 3, score: 99 },
    ]);
    expect(paths(o)).toEqual(["d.md", "a.md", "b.md", "c.md"]);
  });

  it("RRF fusion of an unchanged order is the dense order; a promoted tail doc moves up but not past a strong head", () => {
    const same = [0, 1, 2, 3].map((index) => ({ index, score: 4 - index }));
    expect(paths(rrfFuseOrder(pool, same))).toEqual(paths(denseOrder(pool)));
    const promote = rrfFuseOrder(pool, [
      { index: 3, score: 1 },
      { index: 0, score: 0.5 },
      { index: 1, score: 0.4 },
      { index: 2, score: 0.3 },
    ]);
    expect(paths(promote)[0]).toBe("a.md");
    expect(paths(promote).indexOf("d.md")).toBeLessThan(
      paths(denseOrder(pool)).indexOf("d.md") + 1,
    );
  });

  it("gated order reranks only the listed route classes", () => {
    const hits = [
      { index: 3, score: 1 },
      { index: 0, score: 0 },
    ];
    expect(paths(gatedOrder(pool, hits, new Set(["standard"])))[0]).toBe("d.md");
    expect(paths(gatedOrder(pool, hits, new Set(["lexical"])))).toEqual(paths(denseOrder(pool)));
    expect(paths(gatedOrder(pool, undefined, new Set(["standard"])))).toEqual(
      paths(denseOrder(pool)),
    );
  });
});

describe("classes and statistics", () => {
  const q = (bridge: string[]): GoldenQuery => ({
    id: "q",
    query_text: "x",
    seed_domain: "a",
    target_domain: "b",
    seed_paths: [],
    target_paths: [],
    bridge_paths: bridge,
    description: "d",
  });
  it("multi-hop means the query declares bridge notes", () => {
    expect(hopClass(q(["m.md"]))).toBe("multi-hop");
    expect(hopClass(q([]))).toBe("single-hop");
  });

  it("paired summary reports the delta, wins and losses", () => {
    const s = summarizePaired([0.5, 0.5, 0.5, 0.5], [0.6, 0.4, 0.5, 0.9]);
    expect(s.delta).toBeCloseTo(0.1, 6);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.n).toBe(4);
  });

  it("verdict: a significant loss past -0.05 is CATASTROPHIC, a clear win WINs, no signal is TIE or UNDERPOWERED", () => {
    const base = Array.from({ length: 60 }, () => 0.8);
    const bad = base.map((v, i) => v - 0.2 - (i % 3) * 0.01);
    const good = base.map((v, i) => v + 0.1 + (i % 3) * 0.01);
    const sBad = summarizePaired(base, bad);
    const sGood = summarizePaired(base, good);
    expect(corpusVerdict(sBad, bhDecisions([sBad.p])[0] ?? false)).toBe("CATASTROPHIC");
    expect(corpusVerdict(sGood, bhDecisions([sGood.p])[0] ?? false)).toBe("WIN");
    const flat = summarizePaired(base, base);
    expect(corpusVerdict(flat, false)).toBe("TIE");
    const noisy = summarizePaired([0.9, 0.1, 0.5, 0.3], [0.1, 0.9, 0.3, 0.5]);
    expect(corpusVerdict(noisy, false)).toBe("UNDERPOWERED");
  });

  it("neuron estimate and percentile helpers", () => {
    // 30 passages of ~1,200 characters is ~9,000 tokens: 9,000 / 1e6 * 283 = 2.55 neurons.
    expect(estimateNeurons(36_000)).toBeCloseTo(2.547, 3);
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe("adapters (fetch stubbed)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (body: unknown, status = 200) => {
    const f = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json(body, { status }),
    );
    vi.stubGlobal("fetch", f);
    return f;
  };
  const sent = (
    f: ReturnType<typeof stub>,
  ): { url: string; headers: Record<string, string>; body: unknown } => {
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    return {
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    };
  };

  it("cloudflare: contexts[].text in, result.response[{id,score}] out", async () => {
    const f = stub({
      success: true,
      result: {
        response: [
          { id: 1, score: 0.9 },
          { id: 0, score: 0.1 },
        ],
      },
    });
    const r = cloudflareBgeReranker({ CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok" });
    const hits = await r("q", ["d0", "d1"], 2, []);
    expect(hits).toEqual([
      { index: 1, relevanceScore: 0.9 },
      { index: 0, relevanceScore: 0.1 },
    ]);
    const s = sent(f);
    expect(s.url).toContain("/accounts/acct/ai/run/@cf/baai/bge-reranker-base");
    expect(s.body).toEqual({ query: "q", contexts: [{ text: "d0" }, { text: "d1" }], top_k: 2 });
    expect(s.headers.authorization).toBe("Bearer tok");
  });

  it("deepinfra: the query is repeated once per document, scores come back aligned", async () => {
    const f = stub({ scores: [0.2, 0.8] });
    const r = deepInfraQwen3Reranker({ DEEPINFRA_API_KEY: "k" });
    expect(await r("q", ["d0", "d1"], 2, [])).toEqual([
      { index: 0, relevanceScore: 0.2 },
      { index: 1, relevanceScore: 0.8 },
    ]);
    expect(sent(f).body).toEqual({ queries: ["q", "q"], documents: ["d0", "d1"] });
  });

  it("nvidia: query.text / passages[].text in, rankings[{index,logit}] out", async () => {
    const f = stub({
      rankings: [
        { index: 1, logit: 3.2 },
        { index: 0, logit: -1 },
      ],
    });
    const r = nvidiaNemotronReranker({ NVIDIA_NIM_API_KEY: "k" });
    expect(await r("q", ["d0", "d1"], 2, [])).toEqual([
      { index: 1, relevanceScore: 3.2 },
      { index: 0, relevanceScore: -1 },
    ]);
    expect(sent(f).body).toEqual({
      model: "nvidia/llama-nemotron-rerank-vl-1b-v2",
      query: { text: "q" },
      passages: [{ text: "d0" }, { text: "d1" }],
    });
  });

  it("openrouter reuses the Cohere-compatible provider: documents/top_n in, results[{index,relevance_score}] out", async () => {
    const f = stub({ results: [{ index: 1, relevance_score: 0.7 }] });
    const r = openRouterReranker({ OPENROUTER_API_KEY: "k" }, "m/x:free");
    expect(await r("q", ["d0", "d1"], 2, [])).toEqual([{ index: 1, relevanceScore: 0.7 }]);
    const s = sent(f);
    expect(s.url).toBe("https://openrouter.ai/api/v1/rerank");
    expect(s.body).toEqual({ model: "m/x:free", query: "q", documents: ["d0", "d1"], top_n: 2 });
  });

  it("a missing key refuses to build the adapter", () => {
    expect(() => cloudflareBgeReranker({})).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    expect(() => nvidiaNemotronReranker({})).toThrow(/NVIDIA_NIM_API_KEY/);
  });

  it("a failed call carries the status only: no URL, no key", async () => {
    stub({}, 401);
    const r = nvidiaNemotronReranker({ NVIDIA_NIM_API_KEY: "secret-key" });
    const e = await r("q", ["d"], 1, []).catch((x: unknown) => x as Error);
    expect(e).toBeInstanceOf(RerankHttpError);
    expect(String((e as Error).message)).toBe("HTTP 401");
    expect(JSON.stringify(e)).not.toContain("secret-key");
  });

  it("throttle retries 429 and 5xx, but not a malformed-request 4xx", async () => {
    let calls = 0;
    const flaky = throttled(
      async () => {
        calls++;
        if (calls < 3) throw new RerankHttpError(429, 1);
        return [{ index: 0, relevanceScore: 1 }];
      },
      { minIntervalMs: 0 },
    );
    expect(await flaky("q", ["d"], 1, [])).toHaveLength(1);
    expect(calls).toBe(3);
    let bad = 0;
    const rejecting = throttled(
      async () => {
        bad++;
        throw new RerankHttpError(400, undefined);
      },
      { minIntervalMs: 0 },
    );
    await expect(rejecting("q", ["d"], 1, [])).rejects.toThrow("HTTP 400");
    expect(bad).toBe(1);
  });

  it("the NVIDIA-served arms are public-corpus only", () => {
    expect(PUBLIC_ONLY_ARMS.has("nvidia-nemotron-rerank-vl-1b")).toBe(true);
    expect(PUBLIC_ONLY_ARMS.has("openrouter-nemotron-rerank-vl-1b-free")).toBe(true);
    expect(PUBLIC_ONLY_ARMS.has("cf-bge-reranker-base")).toBe(false);
  });
});
