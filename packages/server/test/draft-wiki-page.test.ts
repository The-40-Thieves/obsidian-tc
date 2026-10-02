// draft_wiki_page: the read-only plan between find_existing_page and commit_wiki_page. An existing
// page comes back with a link-or-extend suggestion and no changeset; a new topic gets the SCHEMA.md
// requirements, a link map and a changeset skeleton. Never writes; respects the read ACL, Obsidian's
// Excluded files and egress.excludePaths.
import { afterEach, describe, expect, it } from "vitest";
import { compileEgressFilter } from "../src/plane/egress-filter";
import type { GatewayCompletionRequest, GatewayRoles } from "../src/plane/gateway";
import { contentHash } from "../src/vault/paths";
import { dbCounts, hashTree, makeWikiHarness, type WikiHarness } from "./wiki-test-helpers";

const SCHEMA = `---
types:
  concept:
    required: [type, summary, sources]
    folder: concepts
  person:
    required: [type, summary]
properties:
  type: [concept, person]
  summary:
  sources:
---
Schema prose.
`;

const FILES: Record<string, string> = {
  "wiki/SCHEMA.md": SCHEMA,
  "wiki/Spaced repetition.md": "# Spaced repetition\n\nReview cards on a schedule.\n",
  "wiki/Related.md": "# Related\n\nOther ideas about memory.\n",
  "wiki/Mentions.md": "Notes\n\nI rely on learning techniques every day.\n",
  "wiki/Linker.md": "See [[Learning techniques]] for more.\n",
  "wiki/Source A.md": "# Source A\n\nA source.\n",
  "journal/Daily.md": "Tried learning techniques today.\n",
  "hidden/Excluded.md": "Private thoughts on learning techniques.\n",
  "private/Secret.md": "Secret learning techniques.\n",
  ".obsidian/app.json": JSON.stringify({ userIgnoreFilters: ["hidden/"] }),
};
const VECTORS = { "Learning techniques": [1, 0, 0, 0] };

let h: WikiHarness;
afterEach(() => h?.v.cleanup());

function harness(opts: Parameters<typeof makeWikiHarness>[0] = {}): WikiHarness {
  h = makeWikiHarness({
    files: FILES,
    wikiFolder: "wiki",
    vectors: VECTORS,
    acl: { readPaths: ["wiki/**", "journal/**", "hidden/**"] },
    ...opts,
  });
  h.seed("wiki/Related.md", [0.98, 0.1, 0, 0]);
  h.seed("private/Secret.md", [0.99, 0.05, 0, 0]);
  h.seed("hidden/Excluded.md", [0.97, 0.1, 0, 0]);
  return h;
}

const TOPIC = { topic: "Learning techniques" };
const paths = (xs: Array<{ path: string }>): string[] => xs.map((x) => x.path).sort();

describe("draft_wiki_page: dedupe", () => {
  it("an existing page is returned with a link-or-extend suggestion and no changeset", async () => {
    const d = await harness().data("draft_wiki_page", { topic: "spaced REPETITION" });
    expect(d.dedupe.verdict).toBe("exists");
    expect(d.existing).toEqual({
      path: "wiki/Spaced repetition.md",
      content_hash: contentHash(FILES["wiki/Spaced repetition.md"] as string),
    });
    expect(d.changeset).toBeNull();
    expect(d.suggestion).toMatch(/link to \[\[wiki\/Spaced repetition\]\]|patch_note/);
    expect(d.dedupe.next.action).toBe("link_to_existing");
  });

  it("a new topic has no `existing` and gets a changeset", async () => {
    const d = await harness().data("draft_wiki_page", TOPIC);
    expect(d.existing).toBeNull();
    expect(d.dedupe.verdict).not.toBe("exists");
    expect(d.changeset).not.toBeNull();
    expect(d.suggestion).toContain("commit_wiki_page");
  });
});

describe("draft_wiki_page: link map", () => {
  it("lists related notes to link to, notes to link from, and notes that already link", async () => {
    const d = await harness().data("draft_wiki_page", {
      ...TOPIC,
      sources: ["[[Source A]]", "https://x.test"],
    });
    const to = Object.fromEntries(d.link_map.link_to.map((e: any) => [e.path, e.reasons]));
    expect(to["wiki/Source A.md"]).toEqual(["source"]);
    expect(to["wiki/Related.md"]).toContain("semantic");
    const from = Object.fromEntries(d.link_map.link_from.map((e: any) => [e.path, e.reasons]));
    expect(from["wiki/Mentions.md"]).toEqual(["mentions_topic"]);
    expect(from["wiki/Related.md"]).toContain("related_wiki_page");
    expect(from["journal/Daily.md"]).toEqual(["mentions_topic"]);
    expect(d.link_map.already_linking).toEqual(["wiki/Linker.md"]);
    // A note that already links the topic needs no patch: its link resolves once the page exists.
    expect(Object.keys(from)).not.toContain("wiki/Linker.md");
    expect(d.link_map.link_from.find((e: any) => e.path === "journal/Daily.md").in_wiki).toBe(
      false,
    );
  });

  it("never offers an Obsidian-excluded note to be patched, nor a note the caller cannot read", async () => {
    const d = await harness().data("draft_wiki_page", TOPIC);
    const everything = JSON.stringify(d);
    expect(everything).not.toContain("hidden/Excluded.md");
    expect(everything).not.toContain("private/Secret.md");
  });

  it("property links count as links: a note linking the topic from a property needs no patch", async () => {
    const files = {
      ...FILES,
      "wiki/Prop.md":
        '---\nrelated: "[[Learning techniques]]"\n---\nmentions learning techniques\n',
    };
    const d = await harness({ files }).data("draft_wiki_page", TOPIC);
    expect(d.link_map.already_linking).toContain("wiki/Prop.md");
    expect(paths(d.link_map.link_from)).not.toContain("wiki/Prop.md");
  });
});

describe("draft_wiki_page: schema and skeleton", () => {
  it("exposes SCHEMA.md and builds the skeleton from the requested type", async () => {
    const d = await harness().data("draft_wiki_page", {
      ...TOPIC,
      type: "concept",
      sources: ["[[Source A]]"],
    });
    expect(d.wiki.folder).toBe("wiki");
    expect(d.wiki.schema).toMatchObject({ path: "wiki/SCHEMA.md", found: true, warnings: [] });
    expect(d.wiki.schema.types.map((t: any) => t.name)).toEqual(["concept", "person"]);
    expect(d.wiki.schema.vocabulary.type).toEqual(["concept", "person"]);
    expect(d.requirements).toMatchObject({
      type: "concept",
      required: ["type", "summary", "sources"],
      problems: [],
    });
    expect(d.changeset.page).toEqual({
      path: "wiki/concepts/Learning techniques.md",
      mode: "create",
      frontmatter: { type: "concept", summary: "", sources: ["[[Source A]]"] },
      body: "",
    });
    expect(d.changeset.notes.join(" ")).toContain("commit_wiki_page");
  });

  it("proposes a link patch (with the note's current prev_hash) for each wiki note that should link", async () => {
    const d = await harness().data("draft_wiki_page", TOPIC);
    expect(paths(d.changeset.patches)).toEqual(["wiki/Mentions.md", "wiki/Related.md"]);
    const mentions = d.changeset.patches.find((p: any) => p.path === "wiki/Mentions.md");
    expect(mentions).toEqual({
      path: "wiki/Mentions.md",
      prev_hash: contentHash(FILES["wiki/Mentions.md"] as string),
      operation: "link",
      heading: "See also",
    });
  });

  it("an unknown type is reported with the types to choose from; no type lists the choices", async () => {
    const hh = harness();
    const bad = await hh.data("draft_wiki_page", { ...TOPIC, type: "recipe" });
    expect(bad.requirements.problems[0]).toContain('"recipe" is not declared');
    expect(bad.requirements.choose_type).toEqual(["concept", "person"]);
    const none = await hh.data("draft_wiki_page", TOPIC);
    expect(none.requirements).toMatchObject({ type: null, choose_type: ["concept", "person"] });
    expect(none.changeset.page.path).toBe("wiki/Learning techniques.md");
  });

  it("a malformed SCHEMA.md is a warning, and the draft still works", async () => {
    const files = { ...FILES, "wiki/SCHEMA.md": "---\ntypes: [broken\n  : :\n---\n" };
    const d = await harness({ files }).data("draft_wiki_page", TOPIC);
    expect(d.wiki.schema.found).toBe(true);
    expect(d.wiki.schema.warnings[0]).toContain("was not read");
    expect(d.wiki.schema.types).toEqual([]);
    expect(d.changeset.page.path).toBe("wiki/Learning techniques.md");
  });

  it("a vault with no wiki folder applies no schema and drafts at the vault root", async () => {
    const d = await harness({ wikiFolder: undefined }).data("draft_wiki_page", TOPIC);
    expect(d.wiki).toMatchObject({ folder: null, schema: { path: null, found: false, types: [] } });
    expect(d.changeset.page.path).toBe("Learning techniques.md");
    expect(d.changeset.notes.join(" ")).toContain("No wiki.folder");
  });
});

describe("draft_wiki_page: read-only", () => {
  it("writes nothing to the vault or the index", async () => {
    const hh = harness();
    const before = { tree: hashTree(hh.v.root), db: dbCounts(hh.v.db) };
    await hh.data("draft_wiki_page", { ...TOPIC, type: "concept" });
    await hh.data("draft_wiki_page", { topic: "Spaced repetition" });
    expect({ tree: hashTree(hh.v.root), db: dbCounts(hh.v.db) }).toEqual(before);
  });

  it("respects the read ACL: a denied note is indistinguishable from a missing one", async () => {
    const d = await harness({ acl: { readPaths: ["wiki/Related.md", "wiki/SCHEMA.md"] } }).data(
      "draft_wiki_page",
      TOPIC,
    );
    expect(paths(d.link_map.link_from)).toEqual(["wiki/Related.md"]);
    expect(d.link_map.already_linking).toEqual([]);
  });
});

describe("draft_wiki_page: the dedupe judge keeps egress rules", () => {
  it("sends neither an egress-excluded nor an Obsidian-excluded note to the judge", async () => {
    const calls: GatewayCompletionRequest[] = [];
    const roles = {
      extract: async () => ({ text: "", model: "m" }),
      synthesize: async () => ({ text: "", model: "m" }),
      judge: async (req: GatewayCompletionRequest) => {
        calls.push(req);
        return { text: JSON.stringify({ verdict: "different", rationale: "no" }), model: "m" };
      },
    } as unknown as GatewayRoles;
    const files = { ...FILES, "wiki/Embargo.md": "BODY-EMBARGO text\n" };
    const hh = harness({
      files,
      roles,
      wikiJudge: {},
      excludeFilter: compileEgressFilter(["wiki/Embargo.md"]),
    });
    hh.seed("wiki/Embargo.md", [0.96, 0.1, 0, 0]);
    const d = await hh.data("draft_wiki_page", { ...TOPIC, judge: true });
    expect(d.dedupe.judge.ran).toBe(true);
    const sent = calls.map((c) => JSON.stringify(c.messages)).join("\n");
    expect(sent).not.toContain("BODY-EMBARGO");
    expect(sent).not.toContain("Private thoughts");
  });
});
