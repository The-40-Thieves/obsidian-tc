// The Excluded-files list is read from `.obsidian/app.json` and persisted + printed by the index
// coverage doctor. That read was lstat-then-readFileSync by path: no link-count check (a hard link to
// an ACL-denied file passed the lstat), and a window between the two calls. It now reads through the
// opened-fd guard every vault file read uses (readNoteBounded), so a hard-linked app.json is not
// loaded, not persisted and not printed. Runs in the native-loaded CI step too.

import { linkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadVaultExclusion } from "../src/search/index-exclusion";
import { OBSIDIAN_APP_CONFIG } from "../src/vault/watcher";
import { makeTempDir, rmTemp } from "./tmp";

describe("index exclusion app.json read is hard-link safe", () => {
  let root: string;
  beforeEach(() => {
    root = makeTempDir("obtc-excl-hl-");
    mkdirSync(join(root, ".obsidian"), { recursive: true });
    mkdirSync(join(root, "private"), { recursive: true });
  });
  afterEach(() => {
    rmTemp(root);
    vi.restoreAllMocks();
  });

  it("does not load, persist or report the filters of a hard-linked app.json", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const secret = join(root, "private", "secret.json");
    writeFileSync(secret, JSON.stringify({ userIgnoreFilters: ["SECRET-FILTER"] }));
    linkSync(secret, join(root, OBSIDIAN_APP_CONFIG));
    const statePath = join(root, "cache", "last-good-exclusions.json");
    const ex = loadVaultExclusion(root, [], statePath);
    expect(ex.effective).toEqual([]);
    expect(ex.obsidian).toEqual([]);
    expect(ex.isExcluded("SECRET-FILTER/x.md")).toBe(false);
    expect(ex.appConfigError).toBeDefined();
    expect(JSON.stringify(ex.appConfigError)).not.toContain("SECRET-FILTER");
    // nothing from the denied file reached the persisted last-good list
    let persisted = "";
    try {
      persisted = readFileSync(statePath, "utf8");
    } catch {
      /* nothing persisted is the pass case */
    }
    expect(persisted).not.toContain("SECRET-FILTER");
  });

  it("an app.json that BECOMES a hard link keeps the last good list, not the new content", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const app = join(root, OBSIDIAN_APP_CONFIG);
    writeFileSync(app, JSON.stringify({ userIgnoreFilters: ["Archive/"] }));
    expect(loadVaultExclusion(root).isExcluded("Archive/x.md")).toBe(true);
    // same size and mtime as far as the cache key goes: only the link count changed
    linkSync(app, join(root, "private", "alias.json"));
    const next = loadVaultExclusion(root);
    expect(next.isExcluded("Archive/x.md")).toBe(true);
    expect(next.appConfigError).toBeDefined();
  });

  it("positive control: an ordinary app.json is still read", () => {
    writeFileSync(
      join(root, OBSIDIAN_APP_CONFIG),
      JSON.stringify({ userIgnoreFilters: ["Archive/"] }),
    );
    const ex = loadVaultExclusion(root);
    expect(ex.obsidian).toEqual(["Archive/"]);
    expect(ex.appConfigError).toBeUndefined();
  });
});
