// THE-934 — the egress predicate every plane boundary calls before a chunk's text reaches the
// gateway or the embedding provider. Pins: basic glob matching (same engine as readPaths),
// unicode folder names, and that a "rename" (a path evaluated differently across two calls) is
// re-evaluated fresh every time rather than sticking to whatever an earlier pass decided.
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

  it("a renamed folder is re-evaluated on the next call, not cached against the old path", () => {
    const filter = compileEgressFilter(["Private/**"]);
    // Before the rename: content lived under Private/ and was excluded.
    expect(isExcludedPath(filter, "Private/note.md")).toBe(true);
    // After a rename OUT of the excluded folder: the SAME logical note, new path, re-evaluated
    // fresh — no per-path memoization anywhere in this module to go stale.
    expect(isExcludedPath(filter, "Public/note.md")).toBe(false);
    // And the reverse: a rename INTO the excluded folder is caught immediately too.
    const filter2 = compileEgressFilter(["Private/**"]);
    expect(isExcludedPath(filter2, "Public/note.md")).toBe(false);
    expect(isExcludedPath(filter2, "Private/note.md")).toBe(true);
  });
});
