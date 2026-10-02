// draft_wiki_page `source`: ingest one note from the vault's raw folder. The server does the
// bookkeeping (is it really a raw source, is the caller allowed to read it, which pages already cite
// it, would a page for it compress anything, the usual dedupe, link map and changeset skeleton) and
// the calling LLM writes the prose. Raw notes are inputs, never pages: they are not dedupe
// candidates and never a link_from patch target. A read-denied raw file answers like a missing one.
import { mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIN_INGEST_SOURCE_CHARS } from "../src/tools/m7/knowledge/wiki-ingest";
import { contentHash } from "../src/vault/paths";
import { dbCounts, hashTree, makeWikiHarness, type WikiHarness } from "./wiki-test-helpers";

const SCHEMA = `---
types:
  concept:
    required: [type, summary, sources]
    folder: concepts
properties:
  type: [concept]
  summary:
  sources:
---
`;

const long = (seed: string, chars = MIN_INGEST_SOURCE_CHARS + 500): string =>
  `# ${seed}\n\n${`${seed} is discussed at length in this saved article. `.repeat(200)}`
    .slice(0, chars)
    .trimEnd();
const short = (chars: number): string => "s".repeat(chars);

const LONG_SOURCE = long("Learning techniques");
const SECRET_BODY = "TOPSECRET-RAW-BODY ".repeat(120);
const FILES: Record<string, string> = {
  "wiki/SCHEMA.md": SCHEMA,
  "wiki/Spaced repetition.md": "# Spaced repetition\n\nReview cards on a schedule.\n",
  "wiki/Related.md": "# Related\n\nOther ideas about memory.\n",
  "wiki/Mentions.md": "Notes\n\nI rely on learning techniques every day.\n",
  "wiki/Cites.md": '---\nsources:\n  - "[[raw/Cited]]"\n---\n# Cites\n\nBuilt from a clip.\n',
  "raw/Learning techniques.md": LONG_SOURCE,
  "raw/Cited.md": long("Cited"),
  "raw/Tip.md": short(300),
  "raw/Private.md": SECRET_BODY,
  "notes/free.md": "Free note.\n",
};
const VECTORS = { "Learning techniques": [1, 0, 0, 0], "Quick tip": [0, 1, 0, 0] };

let h: WikiHarness;
afterEach(() => h?.v.cleanup());

function harness(opts: Parameters<typeof makeWikiHarness>[0] = {}): WikiHarness {
  h = makeWikiHarness({
    files: FILES,
    wikiFolder: "wiki",
    vectors: VECTORS,
    ...opts,
  });
  return h;
}

const draft = (input: Record<string, unknown>) => h.data("draft_wiki_page", input);
const errOf = async (input: Record<string, unknown>) => {
  const r = await h.call("draft_wiki_page", input);
  if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.error as { code: string; message: string; details?: Record<string, unknown> };
};

describe("ingest: a long source becomes a changeset skeleton", () => {
  it("reports the source and cites it in the skeleton's sources and link map", async () => {
    harness();
    const d = await draft({
      topic: "Learning techniques",
      type: "concept",
      source: "raw/Learning techniques.md",
    });
    expect(d.ingest.source).toEqual({
      path: "raw/Learning techniques.md",
      content_hash: contentHash(LONG_SOURCE),
      chars: LONG_SOURCE.trim().length,
      title: "Learning techniques",
    });
    expect(d.ingest.raw_folder).toBe("raw");
    expect(d.ingest.refused).toBeNull();
    expect(d.changeset.page.path).toBe("wiki/concepts/Learning techniques.md");
    expect(d.changeset.page.frontmatter.sources).toEqual(["[[raw/Learning techniques]]"]);
    expect(d.link_map.link_to).toContainEqual(
      expect.objectContaining({ path: "raw/Learning techniques.md", reasons: ["source"] }),
    );
    expect(d.changeset.notes.join(" ")).toMatch(/read_note/);
  });

  it("keeps the sources the caller named and does not list the source twice", async () => {
    harness();
    const d = await draft({
      topic: "Learning techniques",
      source: "raw/Learning techniques.md",
      sources: ["wiki/Related.md", "[[raw/Learning techniques]]"],
    });
    expect(d.changeset.page.frontmatter.sources).toEqual([
      "wiki/Related.md",
      "[[raw/Learning techniques]]",
    ]);
  });

  it("a raw note with the topic's own name is not an existing page", async () => {
    harness();
    const d = await draft({ topic: "Learning techniques", source: "raw/Learning techniques.md" });
    expect(d.dedupe.verdict).toBe("new");
    expect(d.existing).toBeNull();
    expect(d.changeset).not.toBeNull();
  });

  it("raw notes are never dedupe candidates, mentions or patch targets, even when similar", async () => {
    harness();
    h.seed("raw/Learning techniques.md", [0.99, 0.05, 0, 0]);
    h.seed("raw/Cited.md", [0.98, 0.05, 0, 0]);
    h.seed("wiki/Related.md", [0.97, 0.1, 0, 0]);
    const d = await draft({ topic: "Learning techniques", source: "raw/Learning techniques.md" });
    const raw = (xs: Array<{ path: string }>) => xs.filter((x) => x.path.startsWith("raw/"));
    expect(raw(d.dedupe.candidates)).toEqual([]);
    expect(raw(d.link_map.link_from)).toEqual([]);
    expect(raw(d.changeset.patches)).toEqual([]);
    expect(d.link_map.link_from.map((e: { path: string }) => e.path)).toContain("wiki/Related.md");
  });

  it("lists the wiki pages that already cite the source", async () => {
    harness();
    const d = await draft({ topic: "Cited", source: "raw/Cited.md" });
    expect(d.ingest.cited_by).toEqual(["wiki/Cites.md"]);
    const none = await draft({
      topic: "Learning techniques",
      source: "raw/Learning techniques.md",
    });
    expect(none.ingest.cited_by).toEqual([]);
  });

  it("without `source` the answer has no ingest section, as before", async () => {
    harness();
    const d = await draft({ topic: "Learning techniques" });
    expect(d.ingest).toBeUndefined();
  });

  it("writes nothing", async () => {
    harness();
    const before = { files: hashTree(h.v.root), db: dbCounts(h.v.db) };
    await draft({ topic: "Learning techniques", source: "raw/Learning techniques.md" });
    expect(hashTree(h.v.root)).toEqual(before.files);
    expect(dbCounts(h.v.db)).toEqual(before.db);
  });

  it("draft, fill in, commit: the page is written, raw is untouched, and the same-named raw note is no duplicate", async () => {
    harness();
    const d = await draft({
      topic: "Learning techniques",
      type: "concept",
      source: "raw/Learning techniques.md",
    });
    const cs = d.changeset;
    const rawBefore = h.v.read("raw/Learning techniques.md");
    const r = await h.call("commit_wiki_page", {
      topic: cs.topic,
      type: "concept",
      sources: ["raw/Learning techniques.md"],
      page: {
        ...cs.page,
        frontmatter: { ...cs.page.frontmatter, summary: "How to learn." },
        body: "# Learning techniques\n\nDistilled from [[raw/Learning techniques]].\n",
      },
      patches: cs.patches,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(h.v.exists("wiki/concepts/Learning techniques.md")).toBe(true);
    expect(h.v.read("raw/Learning techniques.md")).toBe(rawBefore);
  });
});

describe("ingest: a page that compresses nothing is refused", () => {
  it(`a source under ${MIN_INGEST_SOURCE_CHARS} chars with no existing page: no changeset, the rule is stated`, async () => {
    harness({ files: { ...FILES, "raw/Quick tip.md": short(MIN_INGEST_SOURCE_CHARS - 1) } });
    const d = await draft({ topic: "Quick tip", source: "raw/Quick tip.md" });
    expect(d.changeset).toBeNull();
    expect(d.existing).toBeNull();
    expect(d.ingest.refused).toEqual({
      reason: "source_too_short",
      chars: MIN_INGEST_SOURCE_CHARS - 1,
      min_chars: MIN_INGEST_SOURCE_CHARS,
    });
    expect(d.suggestion).toMatch(new RegExp(`${MIN_INGEST_SOURCE_CHARS - 1}`));
    expect(d.suggestion).toMatch(/no page|existing page/i);
  });

  it("the threshold is exact: N chars is enough, N - 1 is not", async () => {
    harness({
      files: {
        ...FILES,
        "raw/Edge.md": short(MIN_INGEST_SOURCE_CHARS),
        "raw/Under.md": short(MIN_INGEST_SOURCE_CHARS - 1),
      },
    });
    expect((await draft({ topic: "Quick tip", source: "raw/Edge.md" })).changeset).not.toBeNull();
    expect((await draft({ topic: "Quick tip", source: "raw/Under.md" })).changeset).toBeNull();
  });

  it("frontmatter does not count towards the length", async () => {
    harness({
      files: {
        ...FILES,
        "raw/Fm.md": `---\nurl: https://example.com/${"x".repeat(MIN_INGEST_SOURCE_CHARS)}\n---\n${short(40)}`,
      },
    });
    const d = await draft({ topic: "Quick tip", source: "raw/Fm.md" });
    expect(d.ingest.source.chars).toBe(40);
    expect(d.changeset).toBeNull();
  });

  it("a short source is fine when a page already covers the topic: it comes back as the page to extend", async () => {
    harness({ files: { ...FILES, "raw/Quick.md": short(100) } });
    const d = await draft({ topic: "Spaced repetition", source: "raw/Quick.md" });
    expect(d.dedupe.verdict).toBe("exists");
    expect(d.existing?.path).toBe("wiki/Spaced repetition.md");
    expect(d.changeset).toBeNull();
    expect(d.ingest.refused).toBeNull();
  });

  it("a short source is fine when a related wiki page exists to fold it into", async () => {
    harness({ files: { ...FILES, "raw/Quick tip.md": short(100) } });
    h.seed("wiki/Related.md", [0.02, 0.98, 0, 0]);
    const d = await draft({ topic: "Quick tip", source: "raw/Quick tip.md" });
    expect(d.ingest.refused).toBeNull();
    expect(d.changeset).not.toBeNull();
  });

  it("a short source a wiki page already cites is not refused", async () => {
    harness({ files: { ...FILES, "raw/Cited.md": short(100) } });
    const d = await draft({ topic: "Cited", source: "raw/Cited.md" });
    expect(d.ingest.cited_by).toEqual(["wiki/Cites.md"]);
    expect(d.ingest.refused).toBeNull();
  });

  it("an unrelated raw note elsewhere in raw/ does not count as an existing page", async () => {
    harness({
      files: {
        ...FILES,
        "raw/Quick tip.md": short(100),
        "raw/Quick tip two.md": "Quick tip two\n",
      },
    });
    h.seed("raw/Quick tip two.md", [0, 0.99, 0, 0]);
    const d = await draft({ topic: "Quick tip", source: "raw/Quick tip.md" });
    expect(d.ingest.refused?.reason).toBe("source_too_short");
  });
});

describe("ingest: which sources are allowed", () => {
  it("refuses a note outside the raw folder, a wiki page included", async () => {
    harness();
    for (const source of ["notes/free.md", "wiki/Related.md", "rawish/x.md", "raw.md"]) {
      const e = await errOf({ topic: "T", source });
      expect(e.code, source).toBe("invalid_input");
      expect(e.details).toMatchObject({ reason: "outside_raw_folder" });
    }
  });

  it("refuses a source that is not a markdown note", async () => {
    harness({ files: { ...FILES, "raw/clip.pdf": "%PDF" } });
    const e = await errOf({ topic: "T", source: "raw/clip.pdf" });
    expect(e.code).toBe("invalid_input");
  });

  it("refuses when the vault has no raw folder (no wiki folder)", async () => {
    h = makeWikiHarness({ files: FILES, vectors: VECTORS });
    const e = await errOf({ topic: "T", source: "raw/Tip.md" });
    expect(e).toMatchObject({ code: "invalid_input", details: { reason: "no_raw_folder" } });
  });

  it("a missing raw note is note_not_found", async () => {
    harness();
    const e = await errOf({ topic: "T", source: "raw/Nope.md" });
    expect(e.code).toBe("note_not_found");
  });

  it("follows a configured rawFolder", async () => {
    harness({
      rawFolder: "sources",
      files: { ...FILES, "sources/Clip.md": long("Clip") },
      acl: {},
    });
    const d = await draft({ topic: "Clip", source: "sources/Clip.md" });
    expect(d.ingest.raw_folder).toBe("sources");
    const e = await errOf({ topic: "Clip", source: "raw/Tip.md" });
    expect(e.details).toMatchObject({ reason: "outside_raw_folder" });
  });
});

describe("ingest: a read-denied raw file never leaks", () => {
  // raw/Private.md is outside readPaths; the rest of raw/ and the wiki are readable.
  const open = (): WikiHarness =>
    harness({
      acl: { readPaths: ["wiki/**", "notes/**", "raw/Learning techniques.md", "raw/Absent.md"] },
    });

  it("answers exactly like a missing raw file", async () => {
    open();
    const denied = await errOf({ topic: "T", source: "raw/Private.md" });
    const missing = await errOf({ topic: "T", source: "raw/Absent.md" });
    expect(denied.code).toBe("note_not_found");
    expect(denied.code).toBe(missing.code);
    expect(denied.message.replace("Private", "X")).toBe(missing.message.replace("Absent", "X"));
  });

  it("neither its text, its hash nor its path appears anywhere in any answer", async () => {
    open();
    h.seed("raw/Private.md", [0.99, 0.05, 0, 0]);
    const outputs: string[] = [];
    outputs.push(
      JSON.stringify(
        await h.call("draft_wiki_page", {
          vault: "test",
          topic: "Learning techniques",
          source: "raw/Private.md",
        }),
      ),
    );
    outputs.push(
      JSON.stringify(
        await h.call("draft_wiki_page", {
          vault: "test",
          topic: "Learning techniques",
          sources: ["raw/Private.md", "[[Private]]"],
        }),
      ),
    );
    outputs.push(
      JSON.stringify(await h.call("draft_wiki_page", { vault: "test", topic: "Private" })),
    );
    outputs.push(
      JSON.stringify(
        await h.call("draft_wiki_page", {
          vault: "test",
          topic: "Learning techniques",
          source: "raw/Learning techniques.md",
        }),
      ),
    );
    for (const o of outputs) {
      expect(o).not.toContain("TOPSECRET");
      expect(o).not.toContain(contentHash(SECRET_BODY));
    }
    // The first two answers echo the path the caller itself passed (as an error does for a missing
    // note, and `sources` is copied verbatim into the skeleton); the others must not name it.
    for (const o of outputs.slice(2)) expect(o).not.toContain("raw/Private.md");
  });
});

describe.skipIf(process.platform === "win32")(
  "ingest: symlinks are judged like the wiki folder's identity check",
  () => {
    const link = (target: string, at: string): void => {
      const abs = join(h.v.root, at);
      mkdirSync(dirname(abs), { recursive: true });
      symlinkSync(join(h.v.root, target), abs);
    };

    it("a symlink in raw that leads to a wiki page is not a raw source", async () => {
      harness();
      link("wiki/Related.md", "raw/leads-out.md");
      const e = await errOf({ topic: "T", source: "raw/leads-out.md" });
      expect(e.details).toMatchObject({ reason: "outside_raw_folder" });
    });

    it("a symlinked directory in raw that leads out is not raw either", async () => {
      harness();
      link("notes", "raw/deep");
      const e = await errOf({ topic: "T", source: "raw/deep/free.md" });
      expect(e.details).toMatchObject({ reason: "outside_raw_folder" });
    });

    it("a symlink outside raw that leads in is read at the path it was named by: outside", async () => {
      harness();
      link("raw/Tip.md", "notes/tip-alias.md");
      const e = await errOf({ topic: "T", source: "notes/tip-alias.md" });
      expect(e.details).toMatchObject({ reason: "outside_raw_folder" });
    });
  },
);
