// find_existing_page + the LLM judge: the judge resolves AMBIGUOUS candidates only, never overrides
// exact name / alias / wikidata evidence, and any failure leaves the verdict where it was. Egress
// rules (egress.excludePaths, Obsidian Excluded files, the read ACL) decide what is ever sent, which
// is asserted on the judge client's own call log.
import { afterEach, describe, expect, it } from "vitest";
import { compileEgressFilter } from "../src/plane/egress-filter";
import type { GatewayCompletionRequest, GatewayRoles } from "../src/plane/gateway";
import { dbCounts, hashTree, makeWikiHarness, type WikiHarness } from "./wiki-test-helpers";

const FILES: Record<string, string> = {
  "wiki/Spaced repetition.md": "# Spaced repetition\n\nReview cards on a schedule.\n",
  "wiki/Recall schedules.md":
    "# Recall schedules\n\nBODY-RECALL: reviewing at growing intervals.\n",
  "wiki/Interval trick.md": "# Interval trick\n\nBODY-INTERVAL: a related tip.\n",
  "wiki/Unrelated.md": "# Unrelated\n\nBODY-UNRELATED: other matters.\n",
  "wiki/Dup A.md": "---\naliases: [shared alias]\n---\nbody\n",
  "wiki/Dup B.md": "---\naliases: [Shared Alias]\n---\nbody\n",
  "wiki/Hub.md":
    '---\nrelated: "[[Ghost page|ghost topic]]"\n---\nSee [[Ghost page|ghost topic]].\n',
  "hidden/Ghost page.md": "---\naliases: [phantom]\n---\nBODY-GHOST: excluded by Obsidian.\n",
  "wiki/Embargo notes.md": "# Embargo\n\nBODY-EMBARGO: egress excluded.\n",
  "private/Secret plan.md": "# Secret\n\nBODY-SECRET: denied to this caller.\n",
  ".obsidian/app.json": JSON.stringify({ userIgnoreFilters: ["hidden/"] }),
};
const ACL = { readPaths: ["wiki/**", "hidden/**"] };
const VECTORS = {
  "vector topic": [1, 0, 0, 0],
  "ghost topic": [0, 0, 1, 0],
  "unrelated topic": [0, 0, 0, 1],
};

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
const sent = (calls: GatewayCompletionRequest[]): string =>
  calls.map((c) => JSON.stringify(c.messages)).join("\n");
const sentPaths = (calls: GatewayCompletionRequest[]): string[] =>
  calls.flatMap((c) => c.sourcePaths ?? []);

let h: WikiHarness;
afterEach(() => h?.v.cleanup());

function harness(opts: Parameters<typeof makeWikiHarness>[0] = {}): WikiHarness {
  h = makeWikiHarness({
    files: FILES,
    acl: ACL,
    vectors: VECTORS,
    wikiJudge: {},
    ...opts,
  });
  h.seed("wiki/Recall schedules.md", [0.98, 0.1, 0, 0]);
  h.seed("wiki/Interval trick.md", [0.9, 0.3, 0, 0]);
  h.seed("wiki/Unrelated.md", [0, 1, 0, 0]);
  h.seed("private/Secret plan.md", [0.99, 0.05, 0, 0]);
  h.seed("hidden/Ghost page.md", [0, 0, 1, 0]);
  return h;
}

const VT = { topic: "vector topic" };

describe("find_existing_page judge: ambiguous -> exists / new", () => {
  it("without a judge the soft candidates stay ambiguous (baseline)", async () => {
    const { roles } = stubRoles(() => verdict("same_topic"));
    const d = await harness({ roles, wikiJudge: { enabled: false } }).data(
      "find_existing_page",
      VT,
    );
    expect(d.verdict).toBe("ambiguous");
    expect(d.judge).toBeUndefined();
  });

  it("exactly one same_topic candidate moves ambiguous -> exists, with judged_by evidence", async () => {
    const { roles, calls } = stubRoles((req) =>
      JSON.stringify(req.messages).includes("BODY-RECALL")
        ? verdict("same_topic", "Both are about review schedules.")
        : verdict("overlapping"),
    );
    const d = await harness({ roles }).data("find_existing_page", VT);
    expect(d.verdict).toBe("exists");
    expect(d.candidates[0].path).toBe("wiki/Recall schedules.md");
    expect(d.candidates[0].evidence).toContainEqual({
      kind: "judged_by",
      model: "openai:gpt-test-a",
      verdict: "same_topic",
      detail: "Both are about review schedules.",
    });
    expect(d.judged_by).toEqual({
      model: "openai:gpt-test-a",
      verdict: "same_topic",
      rationale: "Both are about review schedules.",
      paths: ["wiki/Recall schedules.md"],
    });
    expect(d.next).toMatchObject({
      action: "link_to_existing",
      paths: ["wiki/Recall schedules.md"],
    });
    expect(d.judge).toMatchObject({ ran: true, model: "openai:gpt-test-a", calls: 2, cached: 0 });
    expect(d.judge.unjudged).toEqual([]);
    expect(calls).toHaveLength(2);
    // Soft evidence stays soft: the verdict moved, the evidence kinds did not turn strong.
    expect(d.candidates[0].strength).toBe("soft");
  });

  it("every candidate judged different -> new", async () => {
    const { roles } = stubRoles(() => verdict("different", "Different subjects."));
    const d = await harness({ roles }).data("find_existing_page", VT);
    expect(d.verdict).toBe("new");
    expect(d.next.action).toBe("create_new");
    expect(d.judged_by).toMatchObject({ verdict: "different", model: "openai:gpt-test-a" });
    expect(d.judged_by.paths.length).toBe(2);
    for (const c of d.candidates)
      expect(c.evidence).toContainEqual(expect.objectContaining({ kind: "judged_by" }));
  });

  it("overlapping, or two same_topic candidates, stay ambiguous but carry the verdicts", async () => {
    const overlap = await harness({ roles: stubRoles(() => verdict("overlapping")).roles }).data(
      "find_existing_page",
      VT,
    );
    expect(overlap.verdict).toBe("ambiguous");
    expect(overlap.judged_by).toBeUndefined();
    expect(overlap.judge.results.map((r: any) => r.verdict)).toEqual([
      "overlapping",
      "overlapping",
    ]);
    h.v.cleanup();
    const both = await harness({ roles: stubRoles(() => verdict("same_topic")).roles }).data(
      "find_existing_page",
      VT,
    );
    expect(both.verdict).toBe("ambiguous");
    expect(both.judged_by).toBeUndefined();
  });

  it("an unjudged candidate (over the per-request cap) keeps `new` out of reach", async () => {
    const { roles, calls } = stubRoles(() => verdict("different"));
    const d = await harness({ roles, wikiJudge: { maxCallsPerRequest: 1 } }).data(
      "find_existing_page",
      VT,
    );
    expect(calls).toHaveLength(1);
    expect(d.verdict).toBe("ambiguous");
    expect(d.judge).toMatchObject({ calls: 1 });
  });
});

describe("find_existing_page judge: exact evidence is never overridden", () => {
  it("a name / alias / wikidata match is never sent to the judge, whatever it would say", async () => {
    const { roles, calls } = stubRoles(() => verdict("different"));
    const hh = harness({ roles });
    const byName = await hh.data("find_existing_page", { topic: "spaced repetition", judge: true });
    expect(byName.verdict).toBe("exists");
    expect(byName.candidates[0].path).toBe("wiki/Spaced repetition.md");
    expect(byName.judge).toMatchObject({ ran: false });
    const byAlias = await hh.data("find_existing_page", { topic: "phantom", judge: true });
    expect(byAlias.verdict).toBe("exists");
    expect(calls).toHaveLength(0);
  });

  it("two pages claiming the same alias stay ambiguous without a judge call", async () => {
    const { roles, calls } = stubRoles(() => verdict("same_topic"));
    const d = await harness({ roles }).data("find_existing_page", {
      topic: "shared alias",
      judge: true,
    });
    expect(d.verdict).toBe("ambiguous");
    expect(d.judge).toMatchObject({ ran: false });
    expect(calls).toHaveLength(0);
  });

  it("`exists` by a path match survives a semantic candidate the judge would call different", async () => {
    const { roles, calls } = stubRoles(() => verdict("different"));
    const hh = harness({ roles, vectors: { ...VECTORS, "spaced repetition": [1, 0, 0, 0] } });
    const d = await hh.data("find_existing_page", { topic: "spaced repetition", judge: true });
    expect(d.verdict).toBe("exists");
    expect(d.candidates[0].path).toBe("wiki/Spaced repetition.md");
    expect(calls).toHaveLength(0);
  });
});

describe("find_existing_page judge: failure never fails the call", () => {
  it.each([
    ["a thrown gateway error", () => Promise.reject(new Error("503 upstream"))],
    ["garbage text", () => "They look the same to me."],
    ["an unknown verdict", () => verdict("duplicate")],
    ["a never-answering judge (timeout)", () => new Promise<string>(() => {})],
  ] as [string, Reply][])("%s -> still ambiguous, call succeeds", async (_n, reply) => {
    const { roles } = stubRoles(reply);
    const t0 = Date.now();
    const d = await harness({ roles, wikiJudge: { timeoutMs: 500 } }).data(
      "find_existing_page",
      VT,
    );
    expect(d.verdict).toBe("ambiguous");
    expect(d.judged_by).toBeUndefined();
    expect(d.candidates.length).toBeGreaterThan(0);
    expect(d.judge.ran).toBe(true);
    expect(d.judge.results).toEqual([]);
    expect(d.judge.unjudged.length).toBeGreaterThan(0);
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it("a half answer: one judged, one failed -> the verdict does not become `new`", async () => {
    const { roles } = stubRoles((_r, n) => (n === 1 ? verdict("different") : "garbage"));
    const d = await harness({ roles }).data("find_existing_page", VT);
    expect(d.verdict).toBe("ambiguous");
  });
});

describe("find_existing_page judge: egress and ACL", () => {
  it("an Obsidian-excluded note (soft link-text candidate) is never sent", async () => {
    const { roles, calls } = stubRoles(() => verdict("same_topic"));
    const d = await harness({ roles }).data("find_existing_page", { topic: "ghost topic" });
    expect(d.candidates.some((c: any) => c.path === "hidden/Ghost page.md" && c.excluded)).toBe(
      true,
    );
    expect(d.verdict).toBe("ambiguous");
    expect(calls).toHaveLength(0);
    expect(sent(calls)).not.toContain("BODY-GHOST");
  });

  it("an egress.excludePaths note is never sent, and the others still are", async () => {
    const { roles, calls } = stubRoles(() => verdict("overlapping"));
    const hh = harness({ roles, excludeFilter: compileEgressFilter(["wiki/Embargo*"]) });
    hh.seed("wiki/Embargo notes.md", [0.97, 0.12, 0, 0]);
    const d = await hh.data("find_existing_page", VT);
    expect(d.candidates.some((c: any) => c.path === "wiki/Embargo notes.md")).toBe(true);
    expect(sentPaths(calls)).not.toContain("wiki/Embargo notes.md");
    expect(sent(calls)).not.toContain("BODY-EMBARGO");
    expect(sentPaths(calls).length).toBeGreaterThan(0);
  });

  it("a note the caller cannot read is neither a candidate nor sent", async () => {
    const { roles, calls } = stubRoles(() => verdict("overlapping"));
    const d = await harness({ roles }).data("find_existing_page", VT);
    expect(JSON.stringify(d)).not.toContain("private/");
    expect(sent(calls)).not.toContain("BODY-SECRET");
    expect(sentPaths(calls).some((p) => p.startsWith("private/"))).toBe(false);
  });

  it("a caller who may read it does get it judged", async () => {
    const { roles, calls } = stubRoles(() => verdict("overlapping"));
    await harness({ roles, acl: { readPaths: ["wiki/**", "private/**"] } }).data(
      "find_existing_page",
      { topic: "vector topic", limit: 25 },
    );
    expect(sent(calls)).toContain("BODY-SECRET");
  });

  it("only the page excerpt and the topic are sent, to the judge role, with their source paths", async () => {
    const { roles, calls } = stubRoles(() => verdict("overlapping"));
    await harness({ roles }).data("find_existing_page", VT);
    for (const c of calls) {
      expect(c.sourcePaths).toHaveLength(1);
      expect(JSON.stringify(c.messages)).toContain("vector topic");
    }
  });
});

describe("find_existing_page judge: the `judge` argument and the caches", () => {
  it("default follows config; judge=false forces off; judge=true forces on", async () => {
    const off = stubRoles(() => verdict("same_topic"));
    const hOff = harness({ roles: off.roles, wikiJudge: { enabled: false } });
    expect((await hOff.data("find_existing_page", VT)).judge).toBeUndefined();
    expect(off.calls).toHaveLength(0);
    const forced = await hOff.data("find_existing_page", { ...VT, judge: true });
    expect(forced.judge.ran).toBe(true);
    expect(off.calls.length).toBeGreaterThan(0);
    h.v.cleanup();

    const on = stubRoles(() => verdict("same_topic"));
    const hOn = harness({ roles: on.roles, wikiJudge: { enabled: true } });
    const skipped = await hOn.data("find_existing_page", { ...VT, judge: false });
    expect(skipped.judge).toBeUndefined();
    expect(on.calls).toHaveLength(0);
    expect((await hOn.data("find_existing_page", VT)).judge.ran).toBe(true);
  });

  it("with no gateway the judge never runs; judge=true says why", async () => {
    const hh = harness({ roles: null });
    expect((await hh.data("find_existing_page", VT)).judge).toBeUndefined();
    const d = await hh.data("find_existing_page", { ...VT, judge: true });
    expect(d.verdict).toBe("ambiguous");
    expect(d.judge).toMatchObject({ ran: false });
    expect(d.judge.reason).toMatch(/gateway|judge/i);
  });

  it("a repeat is served from the cache with no new call; an edit invalidates it", async () => {
    const { roles, calls } = stubRoles(() => verdict("different"));
    const hh = harness({ roles });
    const first = await hh.data("find_existing_page", VT);
    expect(first.judge).toMatchObject({ calls: 2, cached: 0 });
    const second = await hh.data("find_existing_page", VT);
    expect(second.verdict).toBe("new");
    expect(second.judge).toMatchObject({ calls: 0, cached: 2 });
    expect(calls).toHaveLength(2);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${hh.v.root}/wiki/Recall schedules.md`, "# Recall schedules\n\nEDITED body.\n");
    const third = await hh.data("find_existing_page", VT);
    expect(third.judge).toMatchObject({ calls: 1, cached: 1 });
    expect(calls).toHaveLength(3);
  });

  it("the per-day cap leaves later calls ambiguous without failing them", async () => {
    const { roles, calls } = stubRoles(() => verdict("same_topic"));
    const hh = harness({ roles, wikiJudge: { maxCallsPerDay: 2 } });
    const a = await hh.data("find_existing_page", VT);
    expect(a.judge.calls).toBe(2);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${hh.v.root}/wiki/Recall schedules.md`, "# Recall schedules\n\nEDITED.\n");
    writeFileSync(`${hh.v.root}/wiki/Interval trick.md`, "# Interval trick\n\nEDITED.\n");
    const b = await hh.data("find_existing_page", VT);
    expect(b.verdict).toBe("ambiguous");
    expect(b.judge.unjudged).toContainEqual({
      path: "wiki/Recall schedules.md",
      reason: "daily_cap",
    });
    expect(calls).toHaveLength(2);
  });

  it("is still read-only: no vault file changes, no index rows change", async () => {
    const { roles } = stubRoles(() => verdict("same_topic"));
    const hh = harness({ roles });
    const tree = hashTree(hh.v.root);
    const counts = dbCounts(hh.v.db);
    await hh.data("find_existing_page", VT);
    expect(hashTree(hh.v.root)).toEqual(tree);
    expect(dbCounts(hh.v.db)).toEqual(counts);
  });
});
