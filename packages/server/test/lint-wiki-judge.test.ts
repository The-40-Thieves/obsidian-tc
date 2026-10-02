// lint_wiki + the LLM judge on near-duplicate pairs: each proposal carries the verdict, nothing is
// dropped, every failure leaves the proposal as it was, and the egress rules (Excluded files,
// egress.excludePaths, the read ACL) decide what is ever sent.
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { compileEgressFilter } from "../src/plane/egress-filter";
import type { GatewayCompletionRequest, GatewayRoles } from "../src/plane/gateway";
import { registerWikiLintSweep, summarizeLintReport } from "../src/runtime/wiki-lint-sweep";
import { vaultExclusionFor } from "../src/search/index-exclusion";
import type { LintReport } from "../src/tools/m7/knowledge/wiki-lint";
import type { PairJudgeReport } from "../src/tools/m7/knowledge/wiki-lint-judge";
import { dbCounts, hashTree, makeWikiHarness, type WikiHarness } from "./wiki-test-helpers";

const FILES: Record<string, string> = {
  "wiki/Pair A1.md": "BODY-A1 the first wording of topic A.\n",
  "wiki/Pair A2.md": "BODY-A2 a second wording of topic A.\n",
  "wiki/Pair B1.md": "BODY-B1 one take on topic B.\n",
  "wiki/Pair B2.md": "BODY-B2 another take on topic B.\n",
  "wiki/Embargo C1.md": "BODY-EMBARGO-C1 egress excluded.\n",
  "wiki/Embargo C2.md": "BODY-EMBARGO-C2 egress excluded.\n",
  "hidden/Excluded.md": "BODY-HIDDEN excluded by Obsidian.\n",
  "private/Secret P1.md": "BODY-SECRET-1 denied.\n",
  "private/Secret P2.md": "BODY-SECRET-2 denied.\n",
  ".obsidian/app.json": JSON.stringify({ userIgnoreFilters: ["hidden/"] }),
};
const ACL = { readPaths: ["wiki/**", "hidden/**"] };

type Reply = (req: GatewayCompletionRequest, n: number) => string | Promise<string>;
function stubRoles(reply: Reply, model = "openai:gpt-test-a") {
  const calls: GatewayCompletionRequest[] = [];
  const roles = {
    extract: async () => ({ text: "", model }),
    synthesize: async () => ({ text: "", model }),
    judge: async (req: GatewayCompletionRequest) => {
      calls.push(req);
      return { text: await reply(req, calls.length), model };
    },
  } as unknown as GatewayRoles;
  return { roles, calls };
}
const verdict = (v: string, why = "because"): string =>
  JSON.stringify({ verdict: v, rationale: why });
const byTopic: Reply = (req) =>
  JSON.stringify(req.messages).includes("BODY-A1")
    ? verdict("same_topic", "Same practice, reworded.")
    : verdict("different", "Different subjects.");
const sent = (calls: GatewayCompletionRequest[]): string =>
  calls.map((c) => JSON.stringify(c.messages)).join("\n");

let h: WikiHarness;
afterEach(() => h?.v.cleanup());

function fixture(opts: Parameters<typeof makeWikiHarness>[0] = {}): WikiHarness {
  h = makeWikiHarness({ files: FILES, acl: ACL, wikiJudge: {}, ...opts });
  h.seed("wiki/Pair A1.md", [1, 0, 0, 0]);
  h.seed("wiki/Pair A2.md", [0.99, 0.05, 0, 0]);
  h.seed("wiki/Pair B1.md", [0, 1, 0, 0]);
  h.seed("wiki/Pair B2.md", [0.05, 0.99, 0, 0]);
  h.seed("wiki/Embargo C1.md", [0, 0, 1, 0]);
  h.seed("wiki/Embargo C2.md", [0, 0.05, 0.99, 0]);
  h.seed("hidden/Excluded.md", [0.995, 0.02, 0, 0]); // would pair with A1/A2 if not excluded
  h.seed("private/Secret P1.md", [0, 0, 0, 1]);
  h.seed("private/Secret P2.md", [0, 0, 0.05, 0.99]);
  return h;
}

const LINT = { checks: ["near_duplicates"] };
const pair = (d: any, a: string): any =>
  d.proposals.find((p: any) =>
    [p.subject, ...(p.related ?? [])].some((x: string) => x.includes(a)),
  );

describe("lint_wiki judge: near-duplicate proposals carry the verdict", () => {
  it("lint_wiki carries the external-network tag: its judge sends note text outside the process", async () => {
    const hh = fixture({ roles: null });
    expect(hh.v.registry.list().find((t) => t.name === "lint_wiki")?.tags).toContain(
      "external-network",
    );
    // The same tag find_existing_page carries, so one disabledTags entry covers both judges.
    expect(hh.v.registry.list().find((t) => t.name === "find_existing_page")?.tags).toContain(
      "external-network",
    );
  });

  it("without a judge nothing is sent and the proposals are as before", async () => {
    const { roles, calls } = stubRoles(byTopic);
    const d = await fixture({ roles, wikiJudge: { lintEnabled: false } }).data("lint_wiki", LINT);
    expect(d.judge).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(d.proposals.map((p: any) => p.kind)).toEqual([
      "near_duplicate",
      "near_duplicate",
      "near_duplicate",
    ]);
    expect(pair(d, "Pair A1").evidence.judge).toBeUndefined();
  });

  it("judge=true: verdict, rationale and resolved model on each pair; nothing dropped", async () => {
    const { roles, calls } = stubRoles(byTopic);
    const d = await fixture({ roles }).data("lint_wiki", { ...LINT, judge: true });
    expect(d.proposals).toHaveLength(3);
    expect(pair(d, "Pair A1").evidence.judge).toEqual({
      verdict: "same_topic",
      rationale: "Same practice, reworded.",
      model: "openai:gpt-test-a",
      cached: false,
    });
    expect(pair(d, "Pair A1").detail).toContain("same_topic");
    expect(pair(d, "Pair A1").suggested_action).toContain("same topic");
    expect(pair(d, "Pair B1").evidence.judge.verdict).toBe("different");
    expect(pair(d, "Pair B1").suggested_action).toContain("different topics");
    expect(d.judge).toMatchObject({
      ran: true,
      model: "openai:gpt-test-a",
      calls: 3,
      cached: 0,
      by_verdict: { same_topic: 1, different: 2 },
      unjudged: 0,
    });
    expect(calls).toHaveLength(3);
  });

  it("is ON by default when a judge is configured, whatever find_existing_page's switch says", async () => {
    const { roles, calls } = stubRoles(byTopic);
    // DEFAULT_WIKI_JUDGE_SETTINGS: enabled=false (find_existing_page), lintEnabled=true.
    const d = await fixture({ roles, wikiJudge: { enabled: false } }).data("lint_wiki", LINT);
    expect(d.judge.ran).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(pair(d, "Pair A1").evidence.judge.verdict).toBe("same_topic");
    const off = await h.data("lint_wiki", { ...LINT, judge: false });
    expect(off.judge).toBeUndefined();
  });

  it("lintEnabled=false turns the default off; judge=true still opts in", async () => {
    const { roles, calls } = stubRoles(byTopic);
    const hh = fixture({ roles, wikiJudge: { lintEnabled: false } });
    expect((await hh.data("lint_wiki", LINT)).judge).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect((await hh.data("lint_wiki", { ...LINT, judge: true })).judge.ran).toBe(true);
  });

  it("with no judge configured the default-on pass is silent and the proposals are unchanged", async () => {
    const d = await fixture({ roles: null }).data("lint_wiki", LINT);
    expect(d.judge).toBeUndefined();
    expect(d.proposals.map((p: any) => p.kind)).toEqual([
      "near_duplicate",
      "near_duplicate",
      "near_duplicate",
    ]);
    // An explicit ask is still answered, with the reason.
    const asked = await h.data("lint_wiki", { ...LINT, judge: true });
    expect(asked.judge).toMatchObject({ ran: false });
  });

  it("a typesafe provider with no usable backend is no judge, never the gateway", async () => {
    const { roles, calls } = stubRoles(byTopic);
    const d = await fixture({
      roles,
      wikiJudgeBackend: null,
      wikiJudge: { provider: "typesafe" },
    }).data("lint_wiki", LINT);
    expect(d.judge).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(d.proposals).toHaveLength(3);
  });

  it("a backend other than the gateway answers the pairs", async () => {
    const asked: string[] = [];
    const backend = {
      acceptsCachedModel: () => true,
      run: async ({ a }: { a: { title: string } }) => {
        asked.push(a.title);
        return { verdict: "overlapping" as const, rationale: "stub", model: "jev-test@0.5" };
      },
    };
    const d = await fixture({ roles: null, wikiJudgeBackend: backend }).data("lint_wiki", LINT);
    expect(d.judge).toMatchObject({ ran: true, model: "jev-test@0.5" });
    expect(asked.length).toBeGreaterThan(0);
  });

  it("concise responses still show the verdict", async () => {
    const { roles } = stubRoles(byTopic);
    const d = await fixture({ roles }).data("lint_wiki", {
      ...LINT,
      judge: true,
      response_format: "concise",
    });
    expect(pair(d, "Pair A1").judge_verdict).toBe("same_topic");
    expect(pair(d, "Pair B1").judge_verdict).toBe("different");
    expect(pair(d, "Pair A1").evidence).toBeUndefined();
  });
});

describe("lint_wiki judge: failure never fails the call or the proposal", () => {
  it.each([
    ["a thrown gateway error", () => Promise.reject(new Error("503 upstream"))],
    ["garbage text", () => "They look the same."],
    ["an unknown verdict", () => verdict("duplicate")],
    ["a never-answering judge (timeout)", () => new Promise<string>(() => {})],
  ] as [string, Reply][])("%s -> proposals unchanged, pairs unjudged", async (_n, reply) => {
    const { roles } = stubRoles(reply);
    const t0 = Date.now();
    const hh = fixture({ roles, wikiJudge: { timeoutMs: 500 } });
    const plain = await hh.data("lint_wiki", { ...LINT, judge: false });
    const d = await hh.data("lint_wiki", { ...LINT, judge: true });
    expect(d.proposals).toEqual(plain.proposals);
    expect(d.judge).toMatchObject({ ran: true, calls: 0, unjudged: 3 });
    expect(Date.now() - t0).toBeLessThan(8000);
  });

  it("no gateway: judge=true says so, and the call still succeeds", async () => {
    const d = await fixture({ roles: null }).data("lint_wiki", { ...LINT, judge: true });
    expect(d.judge).toMatchObject({ ran: false });
    expect(d.proposals).toHaveLength(3);
    const quiet = await h.data("lint_wiki", LINT);
    expect(quiet.judge).toBeUndefined();
  });
});

describe("lint_wiki judge: egress and ACL", () => {
  it("an Obsidian-excluded note is never a proposal subject and never sent", async () => {
    const { roles, calls } = stubRoles(byTopic);
    const d = await fixture({ roles }).data("lint_wiki", { ...LINT, judge: true });
    expect(JSON.stringify(d)).not.toContain("hidden/");
    expect(sent(calls)).not.toContain("BODY-HIDDEN");
  });

  it("an egress.excludePaths pair keeps its proposal but is never sent", async () => {
    const { roles, calls } = stubRoles(byTopic);
    const d = await fixture({ roles, excludeFilter: compileEgressFilter(["wiki/Embargo*"]) }).data(
      "lint_wiki",
      { ...LINT, judge: true },
    );
    expect(pair(d, "Embargo C1")).toBeDefined();
    expect(pair(d, "Embargo C1").evidence.judge).toBeUndefined();
    expect(sent(calls)).not.toContain("BODY-EMBARGO");
    expect(d.judge).toMatchObject({ calls: 2, unjudged: 1 });
    expect(d.notes.join(" ")).toContain("1 pair(s) were not judged");
  });

  it("a pair the caller cannot read is not proposed and not sent", async () => {
    const { roles, calls } = stubRoles(byTopic);
    const d = await fixture({ roles }).data("lint_wiki", { ...LINT, judge: true });
    expect(JSON.stringify(d)).not.toContain("private/");
    expect(sent(calls)).not.toContain("BODY-SECRET");
  });

  it("a caller who may read the pair does get it judged", async () => {
    const { roles, calls } = stubRoles(byTopic);
    await fixture({ roles, acl: { readPaths: ["wiki/**", "private/**"] } }).data("lint_wiki", {
      ...LINT,
      judge: true,
    });
    expect(sent(calls)).toContain("BODY-SECRET-1");
  });
});

describe("lint_wiki judge: cache and caps", () => {
  it("a repeat run is free; an edited note is judged again", async () => {
    const { roles, calls } = stubRoles(byTopic);
    const hh = fixture({ roles });
    await hh.data("lint_wiki", { ...LINT, judge: true });
    const again = await hh.data("lint_wiki", { ...LINT, judge: true });
    expect(again.judge).toMatchObject({ calls: 0, cached: 3 });
    expect(pair(again, "Pair A1").evidence.judge.cached).toBe(true);
    expect(calls).toHaveLength(3);
    writeFileSync(`${hh.v.root}/wiki/Pair B2.md`, "BODY-B2 EDITED.\n");
    const third = await hh.data("lint_wiki", { ...LINT, judge: true });
    expect(third.judge).toMatchObject({ calls: 1, cached: 2 });
  });

  it("max_judge_calls caps the run, highest-similarity pairs first; the rest stay unjudged", async () => {
    const { roles, calls } = stubRoles(byTopic);
    const d = await fixture({ roles }).data("lint_wiki", {
      ...LINT,
      judge: true,
      max_judge_calls: 1,
    });
    expect(calls).toHaveLength(1);
    expect(d.judge).toMatchObject({ calls: 1, unjudged: 2 });
    expect(d.proposals).toHaveLength(3);
    expect(d.proposals.filter((p: any) => p.evidence?.judge)).toHaveLength(1);
    expect(d.notes.join(" ")).toContain("2 pair(s) were not judged (request_cap)");
  });

  it("the per-day cap holds across calls", async () => {
    const { roles, calls } = stubRoles(byTopic);
    const hh = fixture({ roles, wikiJudge: { maxCallsPerDay: 2 } });
    const d = await hh.data("lint_wiki", { ...LINT, judge: true });
    expect(d.judge).toMatchObject({ calls: 2, unjudged: 1 });
    const e = await hh.data("lint_wiki", { ...LINT, judge: true });
    expect(e.judge).toMatchObject({ calls: 0, cached: 2, unjudged: 1 });
    expect(calls).toHaveLength(2);
  });

  it("is read-only: no vault file changes, no index rows change", async () => {
    const { roles } = stubRoles(byTopic);
    const hh = fixture({ roles });
    const tree = hashTree(hh.v.root);
    const counts = dbCounts(hh.v.db);
    await hh.data("lint_wiki", { ...LINT, judge: true });
    expect(hashTree(hh.v.root)).toEqual(tree);
    expect(dbCounts(hh.v.db)).toEqual(counts);
  });
});

describe("scheduled wiki lint: opt-in judge with a per-run cap", () => {
  type Task = { run: (signal: AbortSignal) => unknown };
  const sweep = async (
    hh: WikiHarness,
    judge: Parameters<typeof registerWikiLintSweep>[1]["judge"] | undefined,
  ): Promise<{ report: LintReport; judged: PairJudgeReport | undefined; line: string }> => {
    const box: { task: Task | null } = { task: null };
    let got: { report: LintReport; judged: PairJudgeReport | undefined } | undefined;
    registerWikiLintSweep({ register: (t: Task) => (box.task = t) } as never, {
      cacheDb: hh.v.db,
      vaults: [{ id: "test", root: hh.v.root }],
      exclusionFor: (id) => vaultExclusionFor(hh.v.vaultRegistry, id),
      embeddingModel: "stub:4",
      intervalMs: 1000,
      maxNotes: 100,
      judge,
      onReport: (report, judged) => {
        got = { report, judged };
      },
    });
    await box.task?.run(new AbortController().signal);
    const g = got as NonNullable<typeof got>;
    return { ...g, line: summarizeLintReport(g.report, g.judged) };
  };
  const settings = {
    enabled: false,
    lintEnabled: true,
    provider: "gateway" as const,
    maxCallsPerRequest: 3,
    maxCallsPerDay: 200,
    timeoutMs: 1000,
    maxNoteChars: 2400,
  };

  it("off unless the sweep is given a judge: nothing is sent", async () => {
    const { roles, calls } = stubRoles(byTopic);
    const hh = fixture({ roles });
    const r = await sweep(hh, undefined);
    expect(r.judged).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(r.line).not.toContain("judge");
  });

  it("judges the pairs up to its per-run cap and logs the verdict counts", async () => {
    const { roles, calls } = stubRoles(byTopic);
    const hh = fixture({ roles });
    const r = await sweep(hh, { roles, settings, maxCalls: 2 });
    expect(calls).toHaveLength(2);
    // The sweep reads with operator access: the private pair is in scope too (4 pairs, 2 judged).
    expect(r.judged).toMatchObject({ ran: true, calls: 2, unjudged: 2 });
    expect(r.line).toContain("judge(openai:gpt-test-a):");
    expect(r.line).toContain("unjudged=2");
    // The proposals the sweep reports carry the verdicts.
    expect(r.report.proposals.filter((p) => p.evidence?.judge)).toHaveLength(2);
  });

  it("a second run is free (cached) and an egress-excluded pair is never sent", async () => {
    const { roles, calls } = stubRoles(byTopic);
    const hh = fixture({ roles });
    const excludeFilter = compileEgressFilter(["wiki/Embargo*"]);
    await sweep(hh, { roles, settings, excludeFilter, maxCalls: 10 });
    const again = await sweep(hh, { roles, settings, excludeFilter, maxCalls: 10 });
    expect(again.judged).toMatchObject({ calls: 0, cached: 3, unjudged: 1 });
    expect(calls).toHaveLength(3);
    expect(sent(calls)).not.toContain("BODY-EMBARGO");
  });

  it("no gateway: the tick still completes and says the judge is off", async () => {
    const hh = fixture({ roles: null });
    const r = await sweep(hh, { roles: null, settings, maxCalls: 5 });
    expect(r.judged).toMatchObject({ ran: false });
    expect(r.line).toContain("judge: off");
    expect(r.report.proposals.filter((p) => p.kind === "near_duplicate")).toHaveLength(4);
  });
});
