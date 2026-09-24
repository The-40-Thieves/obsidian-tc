// THE-1073 fix round 1 (LOW, Opus test gap) — isFrontmatterYamlError (vault/frontmatter.ts) is
// the ONLY thing standing between a frontmatter-YAML failure (skip this one note) and any other
// error (I/O, DB — reject the whole indexVault pass). index-vault-frontmatter-skip.test.ts's case
// (e) exercises it end-to-end through processNote, but nothing pinned the predicate itself in
// isolation, so a change to its matching logic (not just a deleted call site) could pass silently.
import { err, ObsidianTcError } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { isFrontmatterYamlError, parseNote } from "../src/vault/frontmatter";

describe("isFrontmatterYamlError", () => {
  it("is true for parseNote's own frontmatter-YAML throw", () => {
    let caught: unknown;
    try {
      parseNote("---\nbad: [1, 2\n---\nbody\n", "bad.md");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ObsidianTcError);
    expect(isFrontmatterYamlError(caught)).toBe(true);
  });

  it("is false for an invalid_input error carrying only {path} — no `reason: frontmatter_yaml`", () => {
    // Same error CODE as a real frontmatter failure, deliberately, so this proves the predicate
    // keys on `details.reason`, not on `code` alone.
    const e = err.invalidInput("some other validation failure", { path: "note.md" });
    expect(isFrontmatterYamlError(e)).toBe(false);
  });

  it("is false for a different invalid_input `reason`", () => {
    const e = err.invalidInput("wrong shape", { path: "note.md", reason: "something_else" });
    expect(isFrontmatterYamlError(e)).toBe(false);
  });

  it("is false for a plain (non-ObsidianTcError) Error", () => {
    expect(isFrontmatterYamlError(new Error("boom"))).toBe(false);
  });

  it("is false for a non-Error value", () => {
    expect(isFrontmatterYamlError("boom")).toBe(false);
    expect(isFrontmatterYamlError(undefined)).toBe(false);
    expect(isFrontmatterYamlError(null)).toBe(false);
  });

  it("is false for an ObsidianTcError of a DIFFERENT code, even with a matching reason", () => {
    const e = new ObsidianTcError("internal", "boom", { reason: "frontmatter_yaml" });
    expect(isFrontmatterYamlError(e)).toBe(false);
  });
});
