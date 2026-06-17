import { describe, expect, it } from "vitest";
import { FolderAcl, globMatch } from "../src/acl";

describe("glob matcher", () => {
  it("matches single and double star semantics", () => {
    expect(globMatch("*.md", "note.md")).toBe(true);
    expect(globMatch("*.md", "a/note.md")).toBe(false);
    expect(globMatch("notes/**", "notes/a/b.md")).toBe(true);
    expect(globMatch("notes/**", "other/a.md")).toBe(false);
    expect(globMatch("**/secret.md", "a/b/secret.md")).toBe(true);
  });
});

describe("FolderAcl last-match-wins", () => {
  const acl = new FolderAcl({
    readOnly: false,
    defaultScopes: ["read:notes"],
    rules: [
      { glob: "projects/**", scopes: ["read:notes", "write:notes"] },
      { glob: "projects/secret/**", scopes: [] },
    ],
  });
  it("falls back to defaults when no rule matches", () => {
    expect(acl.scopesForPath("daily/2026-06-16.md")).toEqual(["read:notes"]);
  });
  it("applies the matching rule", () => {
    expect(acl.scopesForPath("projects/x.md")).toEqual(["read:notes", "write:notes"]);
  });
  it("lets a later rule override an earlier one", () => {
    expect(acl.scopesForPath("projects/secret/x.md")).toEqual([]);
  });
});
