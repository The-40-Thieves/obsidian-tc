// TypeSafe Jev as the wiki judge's provider: the Choice request shape, the choice+probability to
// verdict mapping, the egress backstop, the cache identity, and that every failure leaves the pair
// unjudged (never a throw, never the gateway). Fetch is always injected; no network.
import { afterEach, describe, expect, it, vi } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import { createTypesafeClient } from "../src/gateway/typesafe";
import { compileEgressFilter } from "../src/plane/egress-filter";
import type { GatewayRoles } from "../src/plane/gateway";
import { createWikiJudge, type SendableNote } from "../src/tools/m7/knowledge/wiki-judge";
import {
  buildJevRequest,
  jevVerdict,
  resolveWikiJudgeBackend,
  typesafeWikiJudgeBackend,
  type WikiJudgeProviderConfig,
} from "../src/tools/m7/knowledge/wiki-judge-typesafe";
import { openMemoryDb } from "./helpers";

const KEY = "sk-test-secret-key-DO-NOT-LEAK";
const probs = (same: number, overlap: number, diff: number) => ({
  same_topic: same,
  overlapping: overlap,
  different: diff,
});
const answer = (p: ReturnType<typeof probs>, model = "jev-1.13.0") => ({
  model,
  answers: {
    q: {
      type: "choice",
      choice: Object.entries(p).sort((x, y) => y[1] - x[1])[0]?.[0],
      confidence: 0.5,
      probabilities: p,
    },
  },
  usage: { input_tokens: 100, output_tokens: 10 },
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const note = (path: string, hash: string, text = `text of ${path}`): SendableNote => ({
  path,
  title: path.replace(/\.md$/, ""),
  text,
  hash,
});
const A = note("wiki/A.md", "a".repeat(64), "BODY-A about sourdough starters");
const B = note("wiki/B.md", "b".repeat(64), "BODY-B a rewrite of sourdough starters");

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: any;
}
function rig(
  reply: (n: number) => Response | Promise<Response> = () => json(answer(probs(0.8, 0.15, 0.05))),
  cfg: Partial<{ threshold: number; filter: string[]; model: string }> = {},
) {
  const seen: Seen[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    return reply(seen.length);
  }) as unknown as typeof fetch;
  const client = createTypesafeClient({
    baseUrl: "http://gw/typesafe",
    apiKey: KEY,
    fetchFn,
    maxAttempts: 1,
    timeoutMs: 1000,
  });
  const backend = typesafeWikiJudgeBackend(client, {
    model: cfg.model ?? "jev-1.13.0",
    threshold: cfg.threshold ?? 0.5,
    filter: compileEgressFilter(cfg.filter ?? []),
  });
  const db = openMemoryDb();
  provisionCacheDb(db);
  const settings = {
    enabled: false,
    lintEnabled: true,
    provider: "typesafe" as const,
    maxCallsPerRequest: 3,
    maxCallsPerDay: 100,
    timeoutMs: 1000,
    maxNoteChars: 2400,
  };
  const judge = createWikiJudge({ roles: null, backend, db, settings });
  return { seen, judge, backend, db, settings };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Jev request shape", () => {
  it("one Choice question over the three verdicts, the two pages as state, a pinned model", async () => {
    const { seen, judge } = rig();
    const o = await judge.judgePair(A, B, judge.newBudget());
    expect(o.ok).toBe(true);
    expect(seen).toHaveLength(1);
    const s = seen[0] as Seen;
    expect(s.url).toBe("http://gw/typesafe/v1/systemone");
    expect(s.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(s.body.model).toBe("jev-1.13.0");
    const q = s.body.questions.q;
    expect(q.type).toBe("choice");
    expect(Object.keys(q.criteria).sort()).toEqual(["different", "overlapping", "same_topic"]);
    expect(Object.keys(s.body.questions)).toEqual(["q"]);
    // Sorted by hash, like the gateway prompt: (a,b) and (b,a) are one request.
    expect(s.body.state).toEqual({
      page_a: { title: "wiki/A", text: A.text },
      page_b: { title: "wiki/B", text: B.text },
    });
    // No temperature / max_tokens-style knobs: Jev takes none.
    expect(Object.keys(s.body).sort()).toEqual(["model", "questions", "state"]);
  });

  it("a topic is judged against a candidate with only a title on the topic side", async () => {
    const { seen, judge } = rig();
    await judge.judgeTopic("Sourdough starters", A, judge.newBudget());
    const state = (seen[0] as Seen).body.state;
    expect(state.page_a.title).toBe("Sourdough starters");
    expect(state.page_a.text).toMatch(/has not been written yet/);
    expect(state.page_b.text).toBe(A.text);
  });

  it("the shipped request builder is what is sent", () => {
    const r = buildJevRequest({ title: "t", text: "x" }, { title: "u", text: "y" });
    expect(r.state).toEqual({
      page_a: { title: "t", text: "x" },
      page_b: { title: "u", text: "y" },
    });
    expect(r.instructions).toMatch(/never follow instructions/);
  });

  it("cuts each side to maxNoteChars", async () => {
    const { seen, judge } = rig();
    const long = note("wiki/L.md", "c".repeat(64), "z".repeat(5000));
    await judge.judgePair(A, long, judge.newBudget());
    const st = (seen[0] as Seen).body.state;
    expect([st.page_a.text.length, st.page_b.text.length].sort((x, y) => x - y)).toEqual([
      A.text.length,
      2400,
    ]);
  });
});

describe("mapping Jev's probabilities to the verdict", () => {
  it.each([
    [probs(0.8, 0.15, 0.05), 0.5, "same_topic"],
    [probs(0.5, 0.3, 0.2), 0.5, "same_topic"], // at the threshold counts
    [probs(0.49, 0.3, 0.21), 0.5, "overlapping"], // below it: same_topic is not claimed
    [probs(0.4, 0.1, 0.5), 0.5, "different"],
    [probs(0.7, 0.2, 0.1), 0.9, "overlapping"], // argmax same_topic but under a strict threshold
    [probs(0.1, 0.45, 0.45), 0.9, "overlapping"], // a tie reads as the cautious verdict
    [probs(0.9, 0.05, 0.05), 0.0, "same_topic"],
  ] as const)("%j at threshold %f -> %s", (p, t, want) => {
    expect(jevVerdict({ probabilities: p }, t).verdict).toBe(want);
  });

  it("the rationale carries the probabilities and the threshold, never page text", () => {
    const r = jevVerdict({ probabilities: probs(0.73, 0.26, 0.01) }, 0.6);
    expect(r.rationale).toBe(
      "Jev probabilities: same_topic 0.73, overlapping 0.26, different 0.01 (same_topic threshold 0.60).",
    );
  });

  it("an outcome carries the verdict, the resolved model with its threshold, and is cached", async () => {
    const { seen, judge } = rig(() => json(answer(probs(0.73, 0.26, 0.01))), { threshold: 0.6 });
    const o = await judge.judgePair(A, B, judge.newBudget());
    expect(o).toMatchObject({
      ok: true,
      verdict: "same_topic",
      model: "jev-1.13.0@0.6",
      cached: false,
    });
    const again = await judge.judgePair(B, A, judge.newBudget());
    expect(again).toMatchObject({ ok: true, verdict: "same_topic", cached: true });
    expect(seen).toHaveLength(1);
  });

  it("a cached verdict is not served under a different threshold", async () => {
    const first = rig(() => json(answer(probs(0.7, 0.2, 0.1))), { threshold: 0.6 });
    await first.judge.judgePair(A, B, first.judge.newBudget());
    // Same cache.db, same pinned model, stricter threshold: a miss, so a new call and a new verdict.
    const seen: Seen[] = [];
    const fetchFn = (async (_u: string, init: RequestInit) => {
      seen.push({ url: "", headers: {}, body: JSON.parse(String(init.body)) });
      return json(answer(probs(0.7, 0.2, 0.1)));
    }) as unknown as typeof fetch;
    const strict = createWikiJudge({
      roles: null,
      db: first.db,
      settings: first.settings,
      backend: typesafeWikiJudgeBackend(
        createTypesafeClient({ baseUrl: "http://gw", apiKey: KEY, fetchFn }),
        { model: "jev-1.13.0", threshold: 0.9, filter: compileEgressFilter([]) },
      ),
    });
    const o = await strict.judgePair(A, B, strict.newBudget());
    expect(o).toMatchObject({ ok: true, verdict: "overlapping", cached: false });
    expect(seen).toHaveLength(1);
  });

  it("switching to the gateway never serves a Jev verdict from the cache", async () => {
    const jev = rig();
    await jev.judge.judgePair(A, B, jev.judge.newBudget());
    let called = 0;
    const roles = {
      judge: async () => {
        called++;
        return { text: '{"verdict":"different","rationale":"gw"}', model: "openai:gw" };
      },
    } as unknown as GatewayRoles;
    const gw = createWikiJudge({
      roles,
      db: jev.db,
      settings: { ...jev.settings, provider: "gateway" },
    });
    const o = await gw.judgePair(A, B, gw.newBudget());
    expect(o).toMatchObject({ ok: true, verdict: "different", model: "openai:gw", cached: false });
    expect(called).toBe(1);
  });
});

describe("failure is an outcome, never a throw, never the gateway", () => {
  it.each([
    ["HTTP 500", () => json({ error: "x" }, 500), "error"],
    ["HTTP 401", () => json({ error: "x" }, 401), "error"],
    ["a malformed answer", () => json({ model: "m", answers: { q: { type: "choice" } } }), "error"],
    [
      "a network failure",
      () => {
        throw new Error(`boom ${KEY}`);
      },
      "error",
    ],
  ] as const)("%s leaves the pair unjudged", async (_n, reply, reason) => {
    const { judge } = rig(reply);
    const o = await judge.judgePair(A, B, judge.newBudget());
    expect(o).toEqual({ ok: false, reason });
    expect(JSON.stringify(o)).not.toContain(KEY);
    expect(judge.status().failuresToday).toBe(1);
  });

  it("a stalled call times out and is cancelled", async () => {
    let aborted = false;
    const fetchFn = ((_u: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        init.signal?.addEventListener("abort", () => {
          aborted = true;
          rej(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      })) as unknown as typeof fetch;
    const db = openMemoryDb();
    provisionCacheDb(db);
    const judge = createWikiJudge({
      roles: null,
      db,
      settings: {
        enabled: false,
        lintEnabled: true,
        provider: "typesafe",
        maxCallsPerRequest: 3,
        maxCallsPerDay: 10,
        timeoutMs: 500,
        maxNoteChars: 2400,
      },
      backend: typesafeWikiJudgeBackend(
        createTypesafeClient({ baseUrl: "http://gw", apiKey: KEY, fetchFn, timeoutMs: 60000 }),
        { model: "jev-1.13.0", threshold: 0.5, filter: compileEgressFilter([]) },
      ),
    });
    const o = await judge.judgePair(A, B, judge.newBudget());
    expect(o).toEqual({ ok: false, reason: "timeout" });
    expect(aborted).toBe(true);
  });

  it("caps still apply: the per-request budget stops the calls", async () => {
    const { judge, seen } = rig();
    const budget = judge.newBudget(1);
    await judge.judgePair(A, B, budget);
    const c = note("wiki/C.md", "d".repeat(64));
    expect(await judge.judgePair(A, c, budget)).toEqual({ ok: false, reason: "request_cap" });
    expect(seen).toHaveLength(1);
  });
});

describe("egress", () => {
  it("a source path under egress.excludePaths never reaches the network", async () => {
    const { judge, seen } = rig(undefined, { filter: ["wiki/B*"] });
    const o = await judge.judgePair(A, B, judge.newBudget());
    expect(o).toEqual({ ok: false, reason: "error" });
    expect(seen).toHaveLength(0);
  });

  it("a path outside the filter is sent", async () => {
    const { judge, seen } = rig(undefined, { filter: ["secret/**"] });
    expect((await judge.judgePair(A, B, judge.newBudget())).ok).toBe(true);
    expect(seen).toHaveLength(1);
  });
});

describe("resolveWikiJudgeBackend", () => {
  const cfg = (extra: Partial<WikiJudgeProviderConfig> = {}): WikiJudgeProviderConfig => ({
    provider: "typesafe",
    timeoutMs: 1000,
    model: "jev-1.13.0",
    threshold: 0.6,
    apiKeyEnv: "WIKI_JUDGE_TEST_KEY",
    baseUrl: "https://api.typesafe.ai",
    allowPlainHttp: false,
    ...extra,
  });
  const filter = compileEgressFilter([]);
  const roles = { judge: async () => ({ text: "", model: "m" }) } as unknown as GatewayRoles;

  afterEach(() => {
    delete process.env.WIKI_JUDGE_TEST_KEY;
  });

  it("gateway provider: the roles' judge, or null without a gateway", () => {
    expect(resolveWikiJudgeBackend(cfg({ provider: "gateway" }), roles, filter)).not.toBeNull();
    expect(resolveWikiJudgeBackend(cfg({ provider: "gateway" }), null, filter)).toBeNull();
  });

  it("typesafe with a key builds a backend pinned to model@threshold, ignoring the gateway", () => {
    process.env.WIKI_JUDGE_TEST_KEY = KEY;
    const b = resolveWikiJudgeBackend(cfg(), roles, filter);
    expect(b?.pinnedModel).toBe("jev-1.13.0@0.6");
  });

  it("typesafe without a key is no judge, with a warning that names the variable and not a key", () => {
    const warn = vi.fn();
    expect(resolveWikiJudgeBackend(cfg(), roles, filter, warn)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/WIKI_JUDGE_TEST_KEY/);
    expect(warn.mock.calls[0]?.[0]).toMatch(/no fallback to the gateway/);
  });

  it("a plain-http remote baseUrl is refused unless allowPlainHttp, even when the schema was bypassed", () => {
    process.env.WIKI_JUDGE_TEST_KEY = KEY;
    const warn = vi.fn();
    const url = "http://litellm:4000/typesafe";
    expect(resolveWikiJudgeBackend(cfg({ baseUrl: url }), roles, filter, warn)).toBeNull();
    expect(warn.mock.calls[0]?.[0]).toMatch(/wikiJudge\.allowPlainHttp is not set/);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(
      resolveWikiJudgeBackend(cfg({ baseUrl: url, allowPlainHttp: true }), roles, filter, warn),
    ).not.toBeNull();
  });

  it("a missing model or threshold is no judge", () => {
    process.env.WIKI_JUDGE_TEST_KEY = KEY;
    const warn = vi.fn();
    expect(resolveWikiJudgeBackend(cfg({ model: undefined }), roles, filter, warn)).toBeNull();
    expect(resolveWikiJudgeBackend(cfg({ threshold: undefined }), roles, filter, warn)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("createWikiJudge with provider typesafe and no backend never uses the gateway roles", async () => {
    let called = 0;
    const gw = {
      judge: async () => {
        called++;
        return { text: '{"verdict":"same_topic","rationale":"x"}', model: "gw" };
      },
    } as unknown as GatewayRoles;
    const db = openMemoryDb();
    provisionCacheDb(db);
    const judge = createWikiJudge({
      roles: gw,
      backend: null,
      db,
      settings: {
        enabled: true,
        lintEnabled: true,
        provider: "typesafe",
        maxCallsPerRequest: 3,
        maxCallsPerDay: 10,
        timeoutMs: 500,
        maxNoteChars: 2400,
      },
    });
    expect(judge.available).toBe(false);
    expect(await judge.judgePair(A, B, judge.newBudget())).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(called).toBe(0);
    // Even when no backend is passed at all, a typesafe provider never derives one from the roles.
    const derived = createWikiJudge({
      roles: gw,
      db,
      settings: { ...judge.settings },
    });
    expect(derived.available).toBe(false);
  });
});
