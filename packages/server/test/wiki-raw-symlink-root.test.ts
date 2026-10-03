// A raw folder that is itself a symlink to another in-vault directory (`raw -> sources`) is one
// directory with two names. The immutable rule must hold on both: writing `sources/clip.md` is
// writing `raw/clip.md`. The wiki/raw overlap check must also be by directory identity, not only by
// spelling, and a raw folder whose identity cannot be established locks nothing extra, refuses ingest
// and never unlocks anything. Reproductions are the two security reviews' of the raw-folder change.
import { mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAcls } from "../src/runtime/acl-build";
import { rawFolderPlacement } from "../src/tools/m7/knowledge/wiki-folder";
import { evaluatePathAcl } from "../src/vault/acl-path";
import { makeTempDir, rmTemp } from "./tmp";
import { hashTree, makeWikiHarness, type WikiHarness } from "./wiki-test-helpers";

const CLIP = "# Clip\n\nA saved article about learning techniques.\n";
const FILES: Record<string, string> = {
  "wiki/SCHEMA.md": "---\ntypes:\n  concept:\n    required: [type]\nproperties:\n  type:\n---\n",
  "wiki/Page.md": "# Page\n\nBody.\n",
  "sources/clip.md": CLIP,
  "notes/free.md": "Free.\n",
};
const CFG = { readOnly: false, defaultScopes: [], rules: [] };

let h: WikiHarness;
const temps: string[] = [];
afterEach(() => {
  h?.v.cleanup();
  for (const t of temps.splice(0)) rmTemp(t);
});

const link = (root: string, target: string, at: string): void => {
  const abs = join(root, at);
  mkdirSync(dirname(abs), { recursive: true });
  symlinkSync(target, abs);
};
const code = (r: { ok: boolean; error?: { code?: string } }): string | undefined =>
  r.ok ? "ok" : r.error?.code;

describe.skipIf(process.platform === "win32")(
  "a raw folder that is a symlink is immutable through its target too",
  () => {
    const symlinked = (opts: Parameters<typeof makeWikiHarness>[0] = {}): WikiHarness =>
      (h = makeWikiHarness({
        files: FILES,
        wikiFolder: "wiki",
        setup: (root) => link(root, join(root, "sources"), "raw"),
        ...opts,
      }));

    it("raw -> sources: a write to sources/clip.md is denied (the grok reproduction)", async () => {
      symlinked();
      const before = hashTree(h.v.root);
      for (const input of [
        { path: "sources/clip.md", content: "x", mode: "overwrite" },
        { path: "sources/new.md", content: "x", mode: "create" },
        { path: "raw/clip.md", content: "x", mode: "overwrite" },
      ])
        expect(code(await h.call("write_note", input))).toBe("acl_denied");
      expect(code(await h.call("append_note", { path: "sources/clip.md", content: "x" }))).toBe(
        "acl_denied",
      );
      expect(
        code(await h.call("move_note", { from: "sources/clip.md", to: "notes/clip.md" })),
      ).toBe("acl_denied");
      expect(hashTree(h.v.root)).toEqual(before);
      expect(h.v.read("sources/clip.md")).toBe(CLIP);
    });

    it("the rest of the vault is still writable", async () => {
      symlinked();
      expect(code(await h.call("write_note", { path: "notes/ok.md", content: "x" }))).toBe("ok");
      expect(code(await h.call("write_note", { path: "wiki/New.md", content: "x" }))).toBe("ok");
    });

    it("the read side is untouched: sources/clip.md still reads", async () => {
      symlinked();
      expect((await h.call("read_note", { path: "sources/clip.md" })).ok).toBe(true);
    });

    it("a configured rawFolder that is a symlink behaves the same", async () => {
      symlinked({ rawFolder: "raw" });
      expect(code(await h.call("write_note", { path: "sources/x.md", content: "x" }))).toBe(
        "acl_denied",
      );
    });

    it("a raw folder reached through a symlinked ancestor locks the real folder", async () => {
      h = makeWikiHarness({
        files: { ...FILES, "store/raw/clip.md": CLIP },
        wikiFolder: "wiki",
        rawFolder: "linked/raw",
        setup: (root) => link(root, join(root, "store"), "linked"),
      });
      expect(code(await h.call("write_note", { path: "store/raw/clip.md", content: "x" }))).toBe(
        "acl_denied",
      );
    });

    it("rawFolderPlacement names the canonical target, and nothing for a plain folder", () => {
      const root = makeTempDir("obtc-placement-");
      temps.push(root);
      mkdirSync(join(root, "sources"));
      mkdirSync(join(root, "plain"));
      link(root, join(root, "sources"), "raw");
      expect(rawFolderPlacement(root, "raw")).toEqual({ ok: true, canonical: "sources" });
      expect(rawFolderPlacement(root, "plain")).toEqual({ ok: true, canonical: null });
      expect(rawFolderPlacement(root, "missing")).toEqual({ ok: true, canonical: null });
    });
  },
);

describe.skipIf(process.platform === "win32")("wiki/raw overlap is judged by identity", () => {
  const vault = (files: Record<string, string>, links: Record<string, string>): string => {
    const root = makeTempDir("obtc-overlap-");
    temps.push(root);
    for (const rel of Object.keys(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
    }
    for (const [at, target] of Object.entries(links)) link(root, join(root, target), at);
    return root;
  };
  const build = (path: string, wiki: { folder: string; rawFolder?: string }) =>
    buildAcls(CFG, [{ id: "v", path, wiki }]);

  it("wiki.folder: sources, rawFolder: raw, raw -> sources is rejected (the codex overlap)", () => {
    const root = vault({ "sources/a.md": "" }, { raw: "sources" });
    expect(() => build(root, { folder: "sources", rawFolder: "raw" })).toThrow(
      /same directory|overlap|must not/i,
    );
  });

  it("raw -> wiki with the default raw folder is rejected (the codex proof)", () => {
    const root = vault({ "wiki/a.md": "" }, { raw: "wiki" });
    expect(() => build(root, { folder: "wiki" })).toThrow(/same directory|overlap|must not/i);
  });

  it("a raw folder that is a symlink INTO the wiki folder is rejected too", () => {
    const root = vault({ "wiki/inner/a.md": "" }, { raw: "wiki/inner" });
    expect(() => build(root, { folder: "wiki" })).toThrow(/same directory|overlap|must not/i);
  });

  it("a wiki folder that is a symlink into the raw folder is rejected", () => {
    const root = vault({ "raw/a.md": "" }, { wiki: "raw" });
    expect(() => build(root, { folder: "wiki" })).toThrow(/same directory|overlap|must not/i);
  });

  it("distinct directories are accepted", () => {
    const root = vault({ "wiki/a.md": "", "sources/a.md": "" }, { raw: "sources" });
    expect(() => build(root, { folder: "wiki" })).not.toThrow();
  });
});

describe.skipIf(process.platform === "win32")(
  "a raw folder whose identity cannot be established fails closed",
  () => {
    const unsafe = (opts: Parameters<typeof makeWikiHarness>[0] = {}): WikiHarness =>
      (h = makeWikiHarness({ files: FILES, wikiFolder: "wiki", ...opts }));

    it("a raw symlink that leaves the vault locks nothing extra, and ingest refuses it", async () => {
      const outside = makeTempDir("obtc-outside-");
      temps.push(outside);
      unsafe({ setup: (root) => link(root, outside, "raw") });
      const placed = rawFolderPlacement(h.v.root, "raw");
      expect(placed.ok).toBe(false);
      // Nothing was unlocked or newly locked: the lexical rule is all there is, and the rest of the
      // vault stays writable.
      expect(code(await h.call("write_note", { path: "notes/ok.md", content: "x" }))).toBe("ok");
      expect(code(await h.call("write_note", { path: "raw/x.md", content: "x" }))).not.toBe("ok");
      const r = await h.call("draft_wiki_page", { topic: "T", source: "raw/x.md" });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("invalid_input");
        expect(r.error.details).toMatchObject({ reason: "raw_folder_unsafe" });
        expect(r.error.message).toMatch(/raw folder/i);
      }
    });

    it("a dangling raw symlink is refused the same way", async () => {
      unsafe({ setup: (root) => link(root, join(root, "nowhere"), "raw") });
      expect(rawFolderPlacement(h.v.root, "raw").ok).toBe(false);
      const r = await h.call("draft_wiki_page", { topic: "T", source: "raw/x.md" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.details).toMatchObject({ reason: "raw_folder_unsafe" });
    });

    it("a raw symlink to the vault root is refused: it would lock every note", async () => {
      unsafe({ setup: (root) => link(root, root, "raw") });
      expect(rawFolderPlacement(h.v.root, "raw").ok).toBe(false);
      expect(code(await h.call("write_note", { path: "notes/ok.md", content: "x" }))).toBe("ok");
    });

    it("an ordinary raw folder is not refused", async () => {
      unsafe({ files: { ...FILES, "raw/clip.md": CLIP } });
      const r = await h.call("draft_wiki_page", { topic: "T", source: "raw/clip.md" });
      expect(r.ok || r.error.details?.reason !== "raw_folder_unsafe").toBe(true);
    });
  },
);

describe.skipIf(process.platform === "win32")("a read-denied symlink is not an oracle", () => {
  // raw/leak.md is a symlink out of the raw folder into private/, which the caller cannot read.
  const hide = (): WikiHarness =>
    (h = makeWikiHarness({
      files: { ...FILES, "raw/clip.md": CLIP, "private/x.md": "secret\n" },
      wikiFolder: "wiki",
      acl: { readPaths: ["wiki/**", "notes/**"] },
      setup: (root) => link(root, join(root, "private/x.md"), "raw/leak.md"),
    }));
  const errOf = async (source: string) => {
    const r = await h.call("draft_wiki_page", { topic: "T", source });
    if (r.ok) throw new Error("expected a refusal");
    return r.error as { code: string; message: string; details?: Record<string, unknown> };
  };

  it("answers note_not_found exactly like a missing file", async () => {
    hide();
    const leak = await errOf("raw/leak.md");
    const missing = await errOf("raw/absent.md");
    expect(leak.code).toBe("note_not_found");
    expect(leak.code).toBe(missing.code);
    expect(leak.details).not.toHaveProperty("reason");
    expect(leak.message).toBe(missing.message);
  });

  it("a readable symlink out of raw is still classified outside_raw_folder", async () => {
    h = makeWikiHarness({
      files: { ...FILES, "raw/clip.md": CLIP },
      wikiFolder: "wiki",
      setup: (root) => link(root, join(root, "notes/free.md"), "raw/leak.md"),
    });
    const e = await errOf("raw/leak.md");
    expect(e.details).toMatchObject({ reason: "outside_raw_folder" });
  });
});

describe("evaluatePathAcl sees the canonical glob", () => {
  it("is plain data on the built ACL: both prefixes are immutable", () => {
    if (process.platform === "win32") return;
    const root = makeTempDir("obtc-eval-");
    temps.push(root);
    mkdirSync(join(root, "sources"));
    link(root, join(root, "sources"), "raw");
    const acl = buildAcls(CFG, [{ id: "v", path: root, wiki: { folder: "wiki" } }]).aclByVault.get(
      "v",
    );
    for (const p of ["raw", "raw/a.md", "sources", "sources/a.md", "sources/deep/a.md"])
      expect(evaluatePathAcl(acl, "write", p).allowed).toBe(false);
    expect(evaluatePathAcl(acl, "write", "sourcesish/a.md").allowed).toBe(true);
    expect(evaluatePathAcl(acl, "read", "sources/a.md").allowed).toBe(true);
  });
});
