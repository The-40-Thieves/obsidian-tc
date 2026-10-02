// "Inside the wiki folder" is judged on what the filesystem resolves the names to (device + inode of
// the folder against every directory above the page), never on a string fold: no spelling can make
// two distinct directories equal. The acl module is mocked to claim a case-insensitive filesystem,
// which is what every Darwin volume is assumed to be: on a case-SENSITIVE volume (case-sensitive
// APFS) `Wiki` and `wiki` are two directories, and the old string fold let a page into the wrong one.
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/acl", async (orig) => ({
  ...(await orig<typeof import("../src/acl")>()),
  CASE_INSENSITIVE_FS: true,
}));

import { assertWikiPagePath } from "../src/tools/m7/knowledge/wiki-folder";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wiki-folder-id-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const mk = (rel: string): void => void mkdirSync(join(root, rel), { recursive: true });
const sameDir = (a: string, b: string): boolean => {
  try {
    const x = statSync(join(root, a));
    const y = statSync(join(root, b));
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
};
const refused = (folder: string, page: string): boolean => {
  try {
    assertWikiPagePath(root, folder, page);
    return false;
  } catch (e) {
    expect(e).toMatchObject({ code: "invalid_input", details: { reason: "outside_wiki_folder" } });
    return true;
  }
};

describe("folder membership follows the filesystem, not a string fold", () => {
  it("case variants that are two directories: refused", () => {
    mk("wiki");
    mk("Wiki");
    // On a case-insensitive volume the second mkdir is the first directory.
    if (sameDir("wiki", "Wiki")) return;
    expect(refused("wiki", "Wiki/probe.md")).toBe(true);
    expect(refused("wiki", "WIKI/sub/probe.md")).toBe(true);
    expect(refused("Wiki", "wiki/probe.md")).toBe(true);
  });

  it("a case variant of a folder that is not there yet is refused (fail closed)", () => {
    expect(refused("wiki", "Wiki/probe.md")).toBe(true);
  });

  it("the folder's own spelling is in it, with or without the folder existing", () => {
    expect(refused("wiki", "wiki/probe.md")).toBe(false);
    mk("wiki/sub");
    expect(refused("wiki", "wiki/sub/probe.md")).toBe(false);
  });

  it("NFC folder configured, NFD page requested: refused where the volume tells them apart", () => {
    const nfc = "Café";
    const nfd = "Café";
    mk(nfc);
    if (sameDir(nfc, nfd)) {
      // A normalisation-insensitive volume (APFS, HFS+): one directory, so it is in the folder.
      expect(refused(nfc, `${nfd}/probe.md`)).toBe(false);
      return;
    }
    writeFileSync(join(root, nfc, "keep.md"), "x");
    expect(refused(nfc, `${nfd}/probe.md`)).toBe(true);
    expect(refused(nfd, `${nfc}/probe.md`)).toBe(true);
  });

  it("an NFD folder name that is not there, requested in NFC: refused", () => {
    expect(refused("Café", "Café/probe.md")).toBe(true);
  });
});
