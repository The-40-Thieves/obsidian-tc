// pathInFolder / assertWikiPagePath: "inside the wiki folder" is strict (a sibling that merely
// shares the prefix is outside), judged on the directory the filesystem resolves for the page
// (never on a string fold), and no vault without a wiki folder has a place for a page.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertWikiPagePath, foldPath, pathInFolder } from "../src/tools/m7/knowledge/wiki-folder";

describe("pathInFolder", () => {
  it("is strict: the folder itself and a prefix-sharing sibling are outside", () => {
    expect(pathInFolder("wiki/a.md", "wiki", false)).toBe(true);
    expect(pathInFolder("wiki/sub/a.md", "wiki", false)).toBe(true);
    expect(pathInFolder("wiki", "wiki", false)).toBe(false);
    expect(pathInFolder("wiki-evil/a.md", "wiki", false)).toBe(false);
    expect(pathInFolder("wikia.md", "wiki", false)).toBe(false);
    expect(pathInFolder("a/wiki/b.md", "wiki", false)).toBe(false);
  });

  it("folds case only on a case-insensitive filesystem", () => {
    expect(pathInFolder("Wiki/a.md", "wiki", false)).toBe(false);
    expect(pathInFolder("Wiki/a.md", "wiki", true)).toBe(true);
    expect(pathInFolder("WIKI/Sub/a.md", "wiki/sub", true)).toBe(true);
  });

  it("compares Unicode in one form (NFC)", () => {
    const nfd = "Café/a.md";
    expect(pathInFolder(nfd, "Café", false)).toBe(true);
    expect(foldPath("Á", true)).toBe(foldPath("á", true));
  });
});

describe("assertWikiPagePath", () => {
  it("refuses when no wiki folder is configured, before looking at the disk", () => {
    expect(() => assertWikiPagePath("/does/not/matter", undefined, "a.md")).toThrow(/wiki\.folder/);
  });

  it("judges the folder on the filesystem: a spelling that is not the folder's own directory is outside", () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-folder-path-"));
    try {
      mkdirSync(join(root, "wiki"));
      expect(() => assertWikiPagePath(root, "wiki", "wiki/a.md")).not.toThrow();
      expect(() => assertWikiPagePath(root, "wiki", "wikia/a.md")).toThrow(
        /inside the wiki folder/,
      );
      expect(() => assertWikiPagePath(root, "wiki", "a.md")).toThrow(/inside the wiki folder/);
      // `Wiki` is this directory on a case-insensitive volume and another one (not there) on a
      // case-sensitive one; either way the answer is what the filesystem says.
      const sameDir = existsSync(join(root, "WIKI"));
      const variant = () => assertWikiPagePath(root, "wiki", "WIKI/a.md");
      if (sameDir) expect(variant).not.toThrow();
      else expect(variant).toThrow(/inside the wiki folder/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
