// commit_wiki_page, the release review's three findings on what happens around the batch:
//  - cleanup AFTER the batch landed (snapshot retention, reindex) is best-effort: a fault there is
//    logged and returned as a warning, never an error, because the write cannot be taken back;
//  - the provenance stamp added to a NEW page's frontmatter is validated with the rest of it, so a
//    wiki whose SCHEMA.md does not declare the stamp key is told so;
//  - a new page has no prior state, so it has no snapshot (the undo is delete_note, which
//    trashes it behind a confirmation); the patches to existing notes are the ones restore_note undoes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProvenanceStamper } from "../src/provenance/stamp";
import { contentHash } from "../src/vault/paths";
import { listSnapshots } from "../src/vault/snapshots";
import { makeWikiHarness, type WikiHarness } from "./wiki-test-helpers";

const gate = vi.hoisted(() => ({ pruneThrows: false }));
vi.mock("../src/vault/snapshots", async (orig) => {
  const actual = await orig<typeof import("../src/vault/snapshots")>();
  return {
    ...actual,
    pruneSnapshots: (...a: Parameters<typeof actual.pruneSnapshots>) => {
      if (gate.pruneThrows) throw new Error("SQLITE_BUSY: database is locked");
      return actual.pruneSnapshots(...a);
    },
  };
});

const KEY = "obsidian_tc_provenance";
const SCHEMA_STRICT = "---\ntypes:\n  concept:\n    required: [type]\nproperties:\n  type:\n---\n";
const SCHEMA_DECLARED = `---\ntypes:\n  concept:\n    required: [type]\nproperties:\n  type:\n  ${KEY}:\n---\n`;
const MENTIONS = "Notes\n\nI rely on learning techniques.\n";
const FILES = (schema: string): Record<string, string> => ({
  "wiki/SCHEMA.md": schema,
  "wiki/Related.md": "# Related\n\nAbout memory.\n",
  "wiki/Mentions.md": MENTIONS,
});
const PAGE = "wiki/concepts/Learning techniques.md";
const changeset = (): Record<string, unknown> => ({
  vault: "test",
  topic: "Learning techniques",
  type: "concept",
  page: {
    path: PAGE,
    frontmatter: { type: "concept" },
    body: "# Learning techniques\n\nSee [[Related]].\n",
  },
  patches: [{ path: "wiki/Mentions.md", prev_hash: contentHash(MENTIONS), operation: "link" }],
});

let h: WikiHarness;
beforeEach(() => {
  gate.pruneThrows = false;
});
afterEach(() => h?.v.cleanup());

const harness = (opts: Parameters<typeof makeWikiHarness>[0] = {}): WikiHarness =>
  (h = makeWikiHarness({
    files: FILES(SCHEMA_STRICT),
    wikiFolder: "wiki",
    snapshots: { enabled: true, retention: 10 },
    ...opts,
  }));

describe("post-commit cleanup is best-effort", () => {
  it("a retention fault (SQLITE_BUSY) after the batch landed is a warning, not an error", async () => {
    harness();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    gate.pruneThrows = true;
    const r = await h.v.call("commit_wiki_page", changeset());
    stderr.mockRestore();
    // The reviewer's reproduction: the page and the backlink patch are on disk ...
    expect(h.v.exists(PAGE)).toBe(true);
    expect(h.v.read("wiki/Mentions.md")).toContain("[[Learning techniques]]");
    // ... so the tool must say so.
    expect(r.ok).toBe(true);
    const data = (r as { data: { committed: boolean; problems: Array<Record<string, string>> } })
      .data;
    expect(data.committed).toBe(true);
    const warning = data.problems.find((p) => p.kind === "post_commit");
    expect(warning?.message).toContain("SQLITE_BUSY");
  });

  it("a reindex fault after the batch landed is a warning, not an error", async () => {
    harness({
      reindex: () => {
        throw new Error("index is busy");
      },
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const r = await h.v.call("commit_wiki_page", changeset());
    stderr.mockRestore();
    expect(h.v.exists(PAGE)).toBe(true);
    expect(r.ok).toBe(true);
    const problems = (r as { data: { problems: Array<Record<string, string>> } }).data.problems;
    expect(
      problems.some((p) => p.kind === "post_commit" && p.message?.includes("index is busy")),
    ).toBe(true);
  });

  it("a fault BEFORE the write is still an error and writes nothing (all-or-nothing on errors)", async () => {
    harness();
    const r = await h.v.call("commit_wiki_page", {
      ...changeset(),
      patches: [{ path: "wiki/Missing.md", operation: "link" }],
    });
    expect(r.ok).toBe(false);
    expect(h.v.exists(PAGE)).toBe(false);
  });
});

describe("the stamp on a new page is validated with the rest of the frontmatter", () => {
  const stamped = (): Parameters<typeof makeWikiHarness>[0] => ({
    provenanceStamp: (db) =>
      new ProvenanceStamper({
        db,
        config: { gitTrailers: false, frontmatter: true, frontmatterKey: KEY },
      }),
  });
  const schemaProblems = (r: unknown): Array<Record<string, string>> =>
    (r as { data: { problems: Array<Record<string, string>> } }).data.problems.filter(
      (p) => p.kind === "schema",
    );

  it("a SCHEMA.md that leaves the stamp key out is told so (the reviewer's reproduction)", async () => {
    harness(stamped());
    const r = await h.v.call("commit_wiki_page", changeset());
    expect(r.ok).toBe(true);
    expect(h.v.read(PAGE)).toContain(KEY);
    expect(schemaProblems(r)).toEqual([
      expect.objectContaining({ field: KEY, path: PAGE, message: expect.stringContaining(KEY) }),
    ]);
  });

  it("a SCHEMA.md that declares the stamp key has no schema problem", async () => {
    harness({ ...stamped(), files: FILES(SCHEMA_DECLARED) });
    const r = await h.v.call("commit_wiki_page", changeset());
    expect(r.ok).toBe(true);
    expect(schemaProblems(r)).toEqual([]);
  });

  it("with the stamp off nothing changes", async () => {
    harness();
    const r = await h.v.call("commit_wiki_page", changeset());
    expect(schemaProblems(r)).toEqual([]);
    expect(h.v.read(PAGE)).not.toContain(KEY);
  });
});

describe("what the snapshots undo", () => {
  it("a new page has no snapshot (nothing to restore to); the patched note does", async () => {
    harness();
    const r = await h.v.call("commit_wiki_page", changeset());
    expect(r.ok).toBe(true);
    expect(listSnapshots(h.v.db, "test", PAGE, 10)).toHaveLength(0);
    const patched = listSnapshots(h.v.db, "test", "wiki/Mentions.md", 10);
    expect(patched).toHaveLength(1);
    expect(patched[0]?.content_hash).toBe(contentHash(MENTIONS));
  });
});
