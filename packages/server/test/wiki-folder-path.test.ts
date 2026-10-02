// pathInFolder / assertWikiPagePath: "inside the wiki folder" is strict (a sibling that merely
// shares the prefix is outside), folded for case and Unicode form only where asked (a
// case-insensitive filesystem), and no vault without a wiki folder has a place for a page.
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

  it("case-folds the folder check when told the filesystem is case-insensitive", () => {
    const root = process.cwd();
    expect(() => assertWikiPagePath(root, "wiki", "Wiki/a.md", false)).toThrow(
      /inside the wiki folder/,
    );
    expect(() => assertWikiPagePath(root, "wiki", "Wiki/a.md", true)).not.toThrow();
  });
});
