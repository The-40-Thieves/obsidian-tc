// Index exclusion mirrors Obsidian's Settings -> Files & links -> Excluded files. The pattern
// dialect is taken from Obsidian 1.13.7's own metadata cache (the help site does not specify it), so
// these cases pin each rule of it: trim/skip-empty, `/.../` regex (case-insensitive, unanchored),
// every other entry a case-insensitive literal PREFIX, uncompilable entries skipped.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compileExclusionEntries,
  loadVaultExclusion,
  NO_EXCLUSION,
  sameExclusion,
  vaultExclusionFor,
} from "../src/search/index-exclusion";
import { VaultRegistry } from "../src/vault/registry";
import { OBSIDIAN_APP_CONFIG } from "../src/vault/watcher";
import { makeTempDir, rmTemp } from "./tmp";

const test = (entries: string[], rel: string): boolean =>
  compileExclusionEntries(entries).test(rel);

describe("pattern parsing (Obsidian userIgnoreFilters dialect)", () => {
  it("a folder entry is a path prefix", () => {
    expect(test(["Archive/"], "Archive/old.md")).toBe(true);
    expect(test(["Archive/"], "Archive/deep/er/old.md")).toBe(true);
    expect(test(["Archive/"], "Other/Archive/old.md")).toBe(false);
    expect(test(["Archive/"], "Archive.md")).toBe(false);
  });

  it("a file entry matches that path, and a bare name is still only a prefix", () => {
    expect(test(["Notes/todo.md"], "Notes/todo.md")).toBe(true);
    expect(test(["Notes/todo.md"], "Notes/todo2.md")).toBe(false);
    // Obsidian does not require the trailing slash: `Draft` also covers `Drafts/x.md`.
    expect(test(["Draft"], "Drafts/x.md")).toBe(true);
    expect(test(["Draft"], "x/Draft.md")).toBe(false);
  });

  it("matching is case-insensitive", () => {
    expect(test(["archive/"], "ARCHIVE/Old.md")).toBe(true);
    expect(test(["/\\.PDF$/"], "a/b.pdf")).toBe(true);
  });

  it("a /.../ entry is an unanchored regex over the whole path", () => {
    expect(test(["/\\.canvas$/"], "boards/plan.canvas")).toBe(true);
    expect(test(["/\\/_[^/]*\\//"], "area/_private/x.md")).toBe(true);
    expect(test(["/\\/_[^/]*\\//"], "area/public/x.md")).toBe(false);
    expect(test(["/^_/"], "_scratch/x.md")).toBe(true);
    expect(test(["/^_/"], "keep/_x.md")).toBe(false);
    expect(test(["/secret/"], "a/my-secret-note.md")).toBe(true);
  });

  it("literal characters that are regex syntax are escaped in a prefix entry", () => {
    expect(test(["a.b/"], "a.b/x.md")).toBe(true);
    expect(test(["a.b/"], "axb/x.md")).toBe(false);
    expect(test(["(draft)/"], "(draft)/x.md")).toBe(true);
    expect(test(["a+b"], "a+b/x.md")).toBe(true);
  });

  it("two characters between slashes boundary: `//` is a literal prefix, `/a/` a regex", () => {
    expect(test(["//"], "//x.md")).toBe(true);
    expect(test(["//"], "a/x.md")).toBe(false);
    expect(test(["/a/"], "banana/x.md")).toBe(true);
  });

  it("an uncompilable entry is skipped and reported, never thrown, and does not disable the rest", () => {
    const c = compileExclusionEntries(["/([/", "Archive/"]);
    expect(c.invalid).toEqual(["/([/"]);
    expect(c.test("Archive/x.md")).toBe(true);
    expect(c.test("Other/x.md")).toBe(false);
    expect(compileExclusionEntries([`/${"a".repeat(2000)}/`]).invalid).toHaveLength(1);
  });

  it("no entries excludes nothing", () => {
    expect(test([], "anything.md")).toBe(false);
    expect(NO_EXCLUSION.isExcluded("anything.md")).toBe(false);
  });
});

describe("loading the effective list", () => {
  let root: string;
  const writeApp = (body: string): void => {
    mkdirSync(join(root, ".obsidian"), { recursive: true });
    writeFileSync(join(root, OBSIDIAN_APP_CONFIG), body);
  };
  beforeEach(() => {
    root = makeTempDir("tc-excl-");
  });
  afterEach(() => rmTemp(root));

  it("a vault without .obsidian/app.json (or without the key) excludes nothing", () => {
    expect(loadVaultExclusion(root)).toBe(NO_EXCLUSION);
    writeApp(JSON.stringify({ promptDelete: false }));
    expect(loadVaultExclusion(root)).toBe(NO_EXCLUSION);
    writeApp(JSON.stringify({ userIgnoreFilters: null }));
    expect(loadVaultExclusion(root).effective).toEqual([]);
  });

  it("reads userIgnoreFilters, trims, drops empties and non-strings", () => {
    writeApp(
      JSON.stringify({ userIgnoreFilters: [" Archive/ ", "", "   ", 7, null, "/\\.pdf$/"] }),
    );
    const ex = loadVaultExclusion(root);
    expect(ex.obsidian).toEqual(["Archive/", "/\\.pdf$/"]);
    expect(ex.isExcluded("Archive/x.md")).toBe(true);
    expect(ex.isExcluded("a/b.pdf")).toBe(true);
    expect(ex.isExcluded("a/b.md")).toBe(false);
  });

  it("merges index.excludePaths (same dialect) after the Obsidian list, de-duplicated", () => {
    writeApp(JSON.stringify({ userIgnoreFilters: ["Archive/"] }));
    const ex = loadVaultExclusion(root, ["Archive/", "Scratch/", "/^tmp-/"]);
    expect(ex.effective).toEqual(["Archive/", "Scratch/", "/^tmp-/"]);
    expect(ex.obsidian).toEqual(["Archive/"]);
    expect(ex.config).toEqual(["Archive/", "Scratch/", "/^tmp-/"]);
    expect(ex.isExcluded("Scratch/a.md")).toBe(true);
    expect(ex.isExcluded("tmp-1/a.md")).toBe(true);
    // the config list alone works without any app.json
    const only = loadVaultExclusion(makeTempDir("tc-excl-none-"), ["Scratch/"]);
    expect(only.isExcluded("Scratch/a.md")).toBe(true);
  });

  it("picks up a changed app.json on the next call (stat-keyed reload)", () => {
    writeApp(JSON.stringify({ userIgnoreFilters: ["A/"] }));
    expect(loadVaultExclusion(root).isExcluded("B/x.md")).toBe(false);
    writeApp(JSON.stringify({ userIgnoreFilters: ["A/", "B/"] }));
    const next = loadVaultExclusion(root);
    expect(next.isExcluded("B/x.md")).toBe(true);
    writeApp(JSON.stringify({ userIgnoreFilters: [] }));
    expect(loadVaultExclusion(root).isExcluded("B/x.md")).toBe(false);
  });

  it("a half-written app.json keeps the last good list and reports the error", () => {
    writeApp(JSON.stringify({ userIgnoreFilters: ["Archive/"] }));
    expect(loadVaultExclusion(root).isExcluded("Archive/x.md")).toBe(true);
    writeApp('{"userIgnoreFilters": ["Arch');
    const broken = loadVaultExclusion(root);
    expect(broken.isExcluded("Archive/x.md")).toBe(true);
    expect(broken.appConfigError).toMatch(/could not be read/);
  });

  it("an app.json that is a symlink is not read", () => {
    mkdirSync(join(root, ".obsidian"), { recursive: true });
    const outside = makeTempDir("tc-excl-out-");
    writeFileSync(join(outside, "app.json"), JSON.stringify({ userIgnoreFilters: ["Archive/"] }));
    try {
      symlinkSync(join(outside, "app.json"), join(root, OBSIDIAN_APP_CONFIG));
    } catch {
      return; // no symlink privilege on this platform
    }
    const ex = loadVaultExclusion(root);
    expect(ex.isExcluded("Archive/x.md")).toBe(false);
    expect(ex.appConfigError).toBeDefined();
  });

  it("resolves through the registry, picking up the configured index.excludePaths", () => {
    writeApp(JSON.stringify({ userIgnoreFilters: ["Archive/"] }));
    const reg = new VaultRegistry([{ id: "v", path: root, index: { excludePaths: ["Scratch/"] } }]);
    const ex = vaultExclusionFor(reg, "v");
    expect(ex.effective).toEqual(["Archive/", "Scratch/"]);
    expect(sameExclusion(ex, vaultExclusionFor(reg, "v"))).toBe(true);
    writeApp(JSON.stringify({ userIgnoreFilters: [] }));
    expect(sameExclusion(ex, vaultExclusionFor(reg, "v"))).toBe(false);
  });
});
