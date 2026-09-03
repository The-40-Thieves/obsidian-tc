// THE-934 — the egress predicate every plane boundary calls before a chunk's text reaches the
// gateway or the embedding provider. Pins: basic glob matching (same engine as readPaths),
// unicode folder names, and (fix round 3, F) the literal-pattern folder-widening normalization
// compileEgressFilter applies -- without it, `["Private"]` or `["Private/"]` (the most natural
// config an operator would write) compiled to an exact-string match that excluded nothing real.
//
// A prior version of this file also had a "renamed folder is re-evaluated" test that compared
// TWO DIFFERENT path strings against the SAME compiled filter across two separate calls -- it
// exercised neither memoization (this module's own header says it deliberately has none against
// the path) nor any actual rename I/O, so it proved only that isExcludedPath is a pure function of
// its two arguments, already implied by every other test here. Removed per fix round 3 (H)'s
// "test the claim it documents or delete it" instruction.
import { describe, expect, it } from "vitest";
import { compileEgressFilter, isExcludedPath } from "../src/plane/egress-filter";

describe("egress filter (THE-934)", () => {
  it("matches a vault-relative path against a **-glob", () => {
    const filter = compileEgressFilter(["Private/**"]);
    expect(isExcludedPath(filter, "Private/journal.md")).toBe(true);
    expect(isExcludedPath(filter, "Private/nested/deep.md")).toBe(true);
    expect(isExcludedPath(filter, "Public/journal.md")).toBe(false);
  });

  it("empty exclude list excludes nothing", () => {
    const filter = compileEgressFilter([]);
    expect(isExcludedPath(filter, "anything.md")).toBe(false);
  });

  it("multiple globs: a match on ANY pattern excludes", () => {
    const filter = compileEgressFilter(["A/**", "B/**"]);
    expect(isExcludedPath(filter, "A/x.md")).toBe(true);
    expect(isExcludedPath(filter, "B/x.md")).toBe(true);
    expect(isExcludedPath(filter, "C/x.md")).toBe(false);
  });

  // Reporter's own fixture shape (THE-934 ticket provenance): a hard output firewall over two
  // personal folders with non-ASCII names.
  it("matches unicode folder names (NFC-normalized, per acl.ts's THE-272 handling)", () => {
    const filter = compileEgressFilter(["🧠 Private/**", "日記/**"]);
    expect(isExcludedPath(filter, "🧠 Private/thoughts.md")).toBe(true);
    expect(isExcludedPath(filter, "日記/2026-09-02.md")).toBe(true);
    expect(isExcludedPath(filter, "Public/日記-mentions.md")).toBe(false);
  });

  // THE-934 fix round 3 (F): globToRegExp (acl.ts) compiles a literal pattern to an EXACT match
  // only -- "Private" -> ^Private$, "Private/" -> ^Private/$ -- neither matches
  // "Private/journal.md". compileEgressFilter now widens every literal pattern to also match
  // everything nested under it as a folder, so the bare-folder-name config an operator would
  // naturally write actually excludes something.
  describe("literal-pattern folder widening (fix round 3, F)", () => {
    it("a bare folder name with no trailing slash excludes everything under it", () => {
      const filter = compileEgressFilter(["Private"]);
      expect(isExcludedPath(filter, "Private/journal.md")).toBe(true);
      expect(isExcludedPath(filter, "Private/nested/deep.md")).toBe(true);
      expect(isExcludedPath(filter, "Public/journal.md")).toBe(false);
    });

    it("a folder name WITH a trailing slash behaves identically", () => {
      const filter = compileEgressFilter(["Private/"]);
      expect(isExcludedPath(filter, "Private/journal.md")).toBe(true);
      expect(isExcludedPath(filter, "Private/nested/deep.md")).toBe(true);
      expect(isExcludedPath(filter, "Public/journal.md")).toBe(false);
    });

    it("an explicit Private/** glob (already had metacharacters) is untouched and behaves the same", () => {
      const filter = compileEgressFilter(["Private/**"]);
      expect(isExcludedPath(filter, "Private/journal.md")).toBe(true);
      expect(isExcludedPath(filter, "Private/nested/deep.md")).toBe(true);
      expect(isExcludedPath(filter, "Public/journal.md")).toBe(false);
    });

    it("a literal FILE pattern still matches only that exact file — a sibling with a longer name does NOT match", () => {
      const filter = compileEgressFilter(["Private/a.md"]);
      expect(isExcludedPath(filter, "Private/a.md")).toBe(true);
      // "Private/a.md.bak" is not nested UNDER "Private/a.md/" as a folder — the widening only
      // ever adds a "/**" suffix, never a bare substring match.
      expect(isExcludedPath(filter, "Private/a.md.bak")).toBe(false);
      expect(isExcludedPath(filter, "Private/b.md")).toBe(false);
    });

    it("all three folder-shaped spellings (Private, Private/, Private/**) exclude the identical set", () => {
      const paths = ["Private/journal.md", "Private/nested/deep.md", "Public/x.md", "Private"];
      const bare = compileEgressFilter(["Private"]);
      const slash = compileEgressFilter(["Private/"]);
      const glob = compileEgressFilter(["Private/**"]);
      for (const p of paths) {
        const b = isExcludedPath(bare, p);
        expect(isExcludedPath(slash, p)).toBe(b);
        // Private/** alone does not match the bare "Private" path itself (no trailing content),
        // but DOES agree with the other two on every path that actually has something after it —
        // asserted separately since that is the one path in this list where they differ by design
        // (Private/** requires the ** to consume at least the rest of the string after the /).
        if (p !== "Private") expect(isExcludedPath(glob, p)).toBe(b);
      }
    });
  });
});
