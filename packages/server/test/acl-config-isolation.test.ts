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

describe("globToRegExp memoization (THE-618)", () => {
  it("the same (glob, caseInsensitive) pair returns the identical compiled RegExp instance", () => {
    const a = globToRegExp("foo/**/bar", true);
    const b = globToRegExp("foo/**/bar", true);
    expect(b).toBe(a);
  });

  it("does not share a cache entry across differing caseInsensitive values for the same glob", () => {
    const sensitive = globToRegExp("Foo/Bar", false);
    const insensitive = globToRegExp("Foo/Bar", true);
    // Object identity: two distinct compiled regexes, not one reused across flags.
    expect(insensitive).not.toBe(sensitive);
    // Behavioral proof: a cache keyed on the glob string ALONE (ignoring caseInsensitive)
    // would hand a case-sensitive caller the case-insensitive compile (or vice versa,
    // depending on call order) — a silent ACL correctness bug. Assert the actual match
    // behavior, not just that the objects differ.
    expect(sensitive.flags).not.toContain("i");
    expect(insensitive.flags).toContain("i");
    expect(sensitive.test("foo/bar")).toBe(false);
    expect(insensitive.test("foo/bar")).toBe(true);
  });

  it("still throws for an over-long glob on a cache hit path (validation is not bypassed)", () => {
    const long = "a".repeat(513);
    expect(() => globToRegExp(long)).toThrow(/glob too long/);
    // Calling it again must still throw — a cache must never memoize past the guard.
    expect(() => globToRegExp(long)).toThrow(/glob too long/);
  });

  it("bounds cache growth: the oldest entry is evicted once the cap is exceeded", () => {
    // audit_provenance's include/exclude tool args feed caller-supplied globs into this cache
    // (graph-health-tools.ts), so an unbounded Map would be a memory-growth vector. Prove the
    // FIFO cap: after the cache is old enough, an entry recompiles instead of growing forever.
    // Regardless of how many entries earlier tests left behind, this entry is the oldest at the
    // moment of insertion, so 1000 subsequent distinct insertions (the cap) are guaranteed to
    // push it out.
    const probe = globToRegExp("evict-probe-0", true);
    for (let i = 0; i < 1000; i++) globToRegExp(`evict-probe-fill-${i}`, true);
    const recompiled = globToRegExp("evict-probe-0", true);
    expect(recompiled).not.toBe(probe);
  });
});
