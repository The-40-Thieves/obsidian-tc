// FolderAcl must never hand out a live reference to its own config arrays. It is constructed once
// per vault and shared across every dispatch, so a caller that mutates a returned array would
// silently rewrite the ACL for all subsequent calls — a privilege escalation that leaves no trace
// in the config file. Also guards glob compilation against unbounded input.
import { describe, expect, it } from "vitest";
import { type AclConfigT, FolderAcl, globToRegExp } from "../src/acl";

function cfg(): AclConfigT {
  return {
    readOnly: false,
    defaultScopes: ["read:notes"],
    rules: [{ glob: "projects/**", scopes: ["read:notes", "write:notes"] }],
    readPaths: ["02-projects/**"],
    writePaths: ["02-projects/**"],
    deletePaths: [],
  };
}

describe("FolderAcl does not leak mutable config references", () => {
  it("mutating the scopes returned for a default-scoped path cannot escalate later calls", () => {
    const acl = new FolderAcl(cfg());

    acl.scopesForPath("inbox/note.md").push("write:notes");

    expect(acl.scopesForPath("inbox/note.md")).toEqual(["read:notes"]);
  });

  it("mutating the scopes returned for a rule-matched path cannot escalate later calls", () => {
    const acl = new FolderAcl(cfg());

    acl.scopesForPath("projects/a.md").push("delete:notes");

    expect(acl.scopesForPath("projects/a.md")).toEqual(["read:notes", "write:notes"]);
  });

  it("mutating a returned scopes array does not bleed across paths sharing the config array", () => {
    const acl = new FolderAcl(cfg());

    acl.scopesForPath("inbox/a.md").length = 0;

    expect(acl.scopesForPath("inbox/b.md")).toEqual(["read:notes"]);
  });

  it.each(["readPaths", "writePaths", "deletePaths"] as const)(
    "mutating the %s whitelist cannot widen it for later calls",
    (which) => {
      const acl = new FolderAcl(cfg());

      acl[which]?.push("**");

      expect(acl[which]).not.toContain("**");
    },
  );
});

describe("globToRegExp input guard", () => {
  it("compiles a glob at the length limit", () => {
    expect(() => globToRegExp("a".repeat(512))).not.toThrow();
  });

  it("rejects a glob longer than the limit instead of compiling it", () => {
    expect(() => globToRegExp("a".repeat(513))).toThrow(/glob too long/);
  });

  it("reports the offending length so a bad config line is identifiable", () => {
    expect(() => globToRegExp("*".repeat(900))).toThrow(/900/);
  });
});
