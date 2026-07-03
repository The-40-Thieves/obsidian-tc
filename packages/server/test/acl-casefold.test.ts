// THE-272 residual: on a case-insensitive filesystem (NTFS/APFS) a path and its case variants name
// the same file, so the folder ACL must fold case there. The control-directory default-deny folds
// UNCONDITIONALLY (any case variant of .obsidian/.git/.trash is always denied — a pure fail-closed
// win, testable on the case-sensitive Linux CI), while path-whitelist glob matching folds only when
// asked (the platform selects it in production; here we exercise both branches explicitly).
import { describe, expect, it } from "vitest";
import { globMatch, isDefaultDenied } from "../src/acl";

describe("THE-272 case-fold folder-ACL hardening", () => {
  it("denies control directories under any case variant", () => {
    expect(isDefaultDenied(".obsidian/plugins/x/data.json")).toBe(true);
    expect(isDefaultDenied(".Obsidian/plugins/x/data.json")).toBe(true);
    expect(isDefaultDenied(".OBSIDIAN/secret")).toBe(true);
    expect(isDefaultDenied(".Git/config")).toBe(true);
    expect(isDefaultDenied(".Trash/note.md")).toBe(true);
  });

  it("keeps the exempt allowlist exact so a mis-cased path is not wrongly exempted", () => {
    expect(isDefaultDenied(".obsidian/bookmarks.json")).toBe(false);
    expect(isDefaultDenied(".obsidian/workspaces.json")).toBe(false);
    // a mis-cased variant is not the exempt file where case is significant, so it stays denied
    expect(isDefaultDenied(".obsidian/Bookmarks.json")).toBe(true);
  });

  it("folds whitelist globs only on request (case-insensitive filesystem)", () => {
    expect(globMatch("public/**", "Public/note.md", true)).toBe(true);
    expect(globMatch("Public/**", "public/note.md", true)).toBe(true);
    expect(globMatch("public/**", "Public/note.md", false)).toBe(false);
  });

  it("matches exact case regardless of the fold flag", () => {
    expect(globMatch("public/**", "public/a/b.md", false)).toBe(true);
    expect(globMatch("public/**", "public/a/b.md", true)).toBe(true);
  });
});
