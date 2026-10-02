// find_existing_page: the read-only "does a page on this topic already exist?" check. One test per
// evidence type, the verdict rule, ACL denial (denied == missing), Obsidian Excluded files (identity
// evidence counts, similarity evidence does not), property-link link text, response formats, and
// proof that a call writes nothing.
import { afterEach, describe, expect, it } from "vitest";
import { verdictOf } from "../src/tools/m7/knowledge/find-existing-page";
import type { PageCandidate } from "../src/tools/m7/knowledge/wiki-evidence";
import { dbCounts, hashTree, makeWikiHarness, type WikiHarness } from "./wiki-test-helpers";

const FILES: Record<string, string> = {
  "wiki/Spaced repetition.md": "# Spaced repetition\n\nReview cards on a schedule.\n",
  "wiki/Memory systems.md": "---\naliases: [SRS, Flash cards]\n---\nbody\n",
  "wiki/Douglas Adams.md": "---\nwikidata: Q42\n---\nAuthor.\n",
  "wiki/Machines.md": "---\ntitle: Quantum Computing Basics\n---\nbody\n",
  "wiki/Hub.md":
    '---\nrelated: "[[Spaced repetition|SRS memory]]"\n---\nSee [[Memory systems|recall aids]].\n',
  "wiki/Dup A.md": "---\naliases: [shared alias]\n---\nbody\n",
  "wiki/Dup B.md": "---\naliases: [Shared Alias]\n---\nbody\n",
  "hidden/Ghost page.md": "---\naliases: [phantom topic]\n---\nbody\n",
  "private/Secret plan.md": "---\naliases: [classified topic]\nwikidata: Q99\n---\nbody\n",
  "wiki/Similar.md": "body\n",
  "wiki/Other.md": "body\n",
  ".obsidian/app.json": JSON.stringify({ userIgnoreFilters: ["hidden/"] }),
};
const ACL = { readPaths: ["wiki/**", "hidden/**"] };

let h: WikiHarness;
afterEach(() => h?.v.cleanup());

function harness(opts: Parameters<typeof makeWikiHarness>[0] = {}): WikiHarness {
  h = makeWikiHarness({
    files: FILES,
    acl: ACL,
    vectors: { "vector topic": [1, 0, 0, 0], "unrelated topic": [0, 0, 1, 0] },
    ...opts,
  });
  h.seed("wiki/Similar.md", [0.98, 0.1, 0, 0]);
  h.seed("wiki/Other.md", [0, 1, 0, 0]);
  h.seed("hidden/Ghost page.md", [1, 0, 0, 0]); // an index that lags behind Excluded files
  h.seed("private/Secret plan.md", [1, 0, 0, 0]);
  return h;
}

const kinds = (c: { evidence: unknown[] }): string[] =>
  c.evidence.map((e) => (typeof e === "string" ? e : (e as { kind: string }).kind));

describe("find_existing_page: evidence types", () => {
  it("exact path / basename match (case-insensitive) is `exists`", async () => {
    const d = await harness().data("find_existing_page", { topic: "spaced REPETITION" });
    expect(d.verdict).toBe("exists");
    expect(d.candidates[0].path).toBe("wiki/Spaced repetition.md");
    expect(kinds(d.candidates[0])).toContain("path");
    expect(d.next.action).toBe("link_to_existing");
  });

  it("a punctuation variant of the name is a name_variant", async () => {
    const d = await harness().data("find_existing_page", { topic: "Spaced-repetition" });
    expect(d.verdict).toBe("exists");
    expect(kinds(d.candidates[0])).toContain("name_variant");
  });

  it("an `aliases` frontmatter entry is `exists`", async () => {
    const d = await harness().data("find_existing_page", { topic: "srs" });
    expect(d.verdict).toBe("exists");
    expect(d.candidates[0]).toMatchObject({ path: "wiki/Memory systems.md" });
    expect(d.candidates[0].evidence).toContainEqual({ kind: "alias", detail: "SRS" });
  });

  it("a `wikidata:` property holding the topic's QID is `exists` (bare id or URL)", async () => {
    const hh = harness();
    const bare = await hh.data("find_existing_page", { topic: "Q42" });
    expect(bare.verdict).toBe("exists");
    expect(bare.candidates[0].evidence).toContainEqual({ kind: "wikidata", detail: "Q42" });
    const url = await hh.data("find_existing_page", {
      topic: "https://www.wikidata.org/wiki/Q42",
    });
    expect(url.candidates[0].path).toBe("wiki/Douglas Adams.md");
  });

  it("a frontmatter title (or H1) matches", async () => {
    const hh = harness();
    const fm = await hh.data("find_existing_page", { topic: "Quantum Computing Basics" });
    expect(fm.verdict).toBe("exists");
    expect(kinds(fm.candidates[0])).toContain("title");
    const h1 = await hh.data("find_existing_page", { topic: "[[Spaced repetition]]" });
    expect(h1.candidates[0].path).toBe("wiki/Spaced repetition.md");
  });

  it("a PROPERTY link's alias text is evidence (link_text, tagged with the property)", async () => {
    const d = await harness().data("find_existing_page", { topic: "SRS memory" });
    const c = d.candidates.find((x: any) => x.path === "wiki/Spaced repetition.md");
    expect(c).toBeDefined();
    expect(c.evidence).toContainEqual(
      expect.objectContaining({ kind: "link_text", property: "related" }),
    );
    // soft evidence only: it never says `exists` on its own.
    expect(c.strength).toBe("soft");
    expect(d.verdict).toBe("ambiguous");
  });

  it("a body link's alias text counts as link_text too", async () => {
    const d = await harness().data("find_existing_page", { topic: "recall aids" });
    expect(d.candidates[0]).toMatchObject({ path: "wiki/Memory systems.md" });
    expect(kinds(d.candidates[0])).toEqual(["link_text"]);
  });

  it("semantic near-neighbours are soft evidence with their score", async () => {
    const d = await harness().data("find_existing_page", { topic: "vector topic" });
    expect(d.semantic.checked).toBe(true);
    const c = d.candidates.find((x: any) => x.path === "wiki/Similar.md");
    expect(c.evidence).toContainEqual({ kind: "semantic", score: expect.any(Number) });
    expect(c.strength).toBe("soft");
    expect(d.verdict).toBe("ambiguous");
    expect(d.candidates.some((x: any) => x.path === "wiki/Other.md")).toBe(false);
  });

  it("min_similarity moves the band", async () => {
    const d = await harness().data("find_existing_page", {
      topic: "vector topic",
      min_similarity: 0.999,
    });
    expect(d.candidates).toEqual([]);
    expect(d.verdict).toBe("new");
  });
});

describe("find_existing_page: verdict logic", () => {
  const cand = (path: string, ...kindsOf: string[]): PageCandidate => ({
    path,
    excluded: false,
    evidence: kindsOf.map((kind) => ({ kind }) as PageCandidate["evidence"][number]),
  });

  it("no candidates -> new", () => expect(verdictOf([])).toBe("new"));
  it("one strong candidate -> exists", () =>
    expect(verdictOf([cand("a.md", "alias")])).toBe("exists"));
  it("two strong candidates -> ambiguous", () =>
    expect(verdictOf([cand("a.md", "alias"), cand("b.md", "title")])).toBe("ambiguous"));
  it("one path match wins over an alias elsewhere (Obsidian resolves [[topic]] to it)", () =>
    expect(verdictOf([cand("a.md", "path"), cand("b.md", "alias")])).toBe("exists"));
  it("two path matches (same basename in two folders) -> ambiguous", () =>
    expect(verdictOf([cand("a/x.md", "path"), cand("b/x.md", "path")])).toBe("ambiguous"));
  it("soft evidence alone -> ambiguous, never exists", () => {
    expect(verdictOf([cand("a.md", "semantic")])).toBe("ambiguous");
    expect(verdictOf([cand("a.md", "link_text")])).toBe("ambiguous");
  });

  it("two notes sharing one alias are ambiguous end to end", async () => {
    const d = await harness().data("find_existing_page", { topic: "shared alias" });
    expect(d.verdict).toBe("ambiguous");
    expect(d.candidates.map((c: any) => c.path).sort()).toEqual(["wiki/Dup A.md", "wiki/Dup B.md"]);
    expect(d.next.action).toBe("review_candidates");
  });

  it("nothing found -> new, and the next step is to create", async () => {
    const d = await harness().data("find_existing_page", { topic: "unrelated topic" });
    expect(d.verdict).toBe("new");
    expect(d.next).toMatchObject({ action: "create_new", tool: "write_note" });
  });
});

describe("find_existing_page: ACL (denied == missing)", () => {
  it("a note the caller cannot read matches nothing: not by alias, wikidata, nor similarity", async () => {
    const hh = harness();
    for (const topic of ["classified topic", "Q99", "Secret plan"]) {
      const d = await hh.data("find_existing_page", { topic });
      expect(JSON.stringify(d)).not.toContain("private/");
      expect(d.verdict).toBe("new");
    }
    const sim = await hh.data("find_existing_page", { topic: "vector topic" });
    expect(JSON.stringify(sim)).not.toContain("private/");
  });

  it("the same note is found by a caller whose ACL allows it", async () => {
    const hh = harness({ acl: { readPaths: ["wiki/**", "hidden/**", "private/**"] } });
    const d = await hh.data("find_existing_page", { topic: "classified topic" });
    expect(d.verdict).toBe("exists");
    expect(d.candidates[0].path).toBe("private/Secret plan.md");
  });
});

describe("find_existing_page: Obsidian Excluded files", () => {
  it("an excluded note still counts as `exists` by name or alias, flagged excluded", async () => {
    const hh = harness();
    for (const topic of ["Ghost page", "phantom topic"]) {
      const d = await hh.data("find_existing_page", { topic });
      expect(d.verdict).toBe("exists");
      expect(d.candidates[0]).toMatchObject({ path: "hidden/Ghost page.md", excluded: true });
      expect(d.next.note).toContain("Excluded files");
    }
  });

  it("an excluded note is never a SIMILARITY candidate, even if the index still holds its vector", async () => {
    const d = await harness().data("find_existing_page", { topic: "vector topic" });
    expect(d.candidates.some((c: any) => c.path.startsWith("hidden/"))).toBe(false);
  });
});

describe("find_existing_page: scope, formats, safety", () => {
  it("folder restricts which candidates are reported", async () => {
    const hh = harness();
    const inside = await hh.data("find_existing_page", { topic: "SRS", folder: "wiki" });
    expect(inside.verdict).toBe("exists");
    const outside = await hh.data("find_existing_page", { topic: "SRS", folder: "hidden" });
    expect(outside.verdict).toBe("new");
  });

  it("concise returns evidence kinds only; detailed returns the evidence objects", async () => {
    const hh = harness();
    const concise = await hh.data("find_existing_page", {
      topic: "SRS",
      response_format: "concise",
    });
    expect(concise.candidates[0].evidence).toEqual(["alias"]);
    const detailed = await hh.data("find_existing_page", {
      topic: "SRS",
      response_format: "detailed",
    });
    expect(detailed.candidates[0].evidence[0]).toEqual({ kind: "alias", detail: "SRS" });
    expect(Object.keys(concise).sort()).toEqual(Object.keys(detailed).sort());
  });

  it("an embedding outage degrades the similarity half, not the answer", async () => {
    const hh = harness({ failEmbed: true });
    const d = await hh.data("find_existing_page", { topic: "SRS" });
    expect(d.verdict).toBe("exists");
    expect(d.semantic.checked).toBe(false);
    expect(d.semantic.reason).toContain("provider down");
  });

  it("never writes: vault files and cache rows are identical before and after", async () => {
    const hh = harness();
    const files = hashTree(hh.v.root);
    const rows = dbCounts(hh.v.db);
    for (const topic of ["SRS", "Q42", "vector topic", "Ghost page", "nothing here"])
      await hh.data("find_existing_page", { topic });
    expect(hashTree(hh.v.root)).toEqual(files);
    expect(dbCounts(hh.v.db)).toEqual(rows);
  });

  it("is a read-only tool: requires only read:notes", async () => {
    const tool = harness()
      .v.registry.list()
      .find((t) => t.name === "find_existing_page");
    expect(tool?.requiredScopes).toEqual(["read:notes"]);
    expect(tool?.description).toMatch(/before (creating|write_note)/i);
  });
});
