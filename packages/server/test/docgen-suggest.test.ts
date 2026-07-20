// docgen prose suggestion (THE-477): the prompt builder is pure + testable without a gateway. The
// LLM call + git wiring stay out of the test (advisory tool, operator-run).
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProsePrompt, resolveDocPath } from "../scripts/docgen/suggest-prose";

describe("buildProsePrompt (THE-477)", () => {
  const diff = "+| `patch_note` | write | `write:notes` | anchored edit |";
  const docs = [{ name: "README.md", content: "obsidian-tc is a read-only server." }];
  const prompt = buildProsePrompt(diff, docs);

  it("grounds the model in the reference diff and the current prose", () => {
    expect(prompt).toContain(diff);
    expect(prompt).toContain("obsidian-tc is a read-only server.");
    expect(prompt).toContain("### README.md");
  });

  it("instructs an escape hatch so it stays conservative/advisory", () => {
    expect(prompt).toContain("NO CHANGE NEEDED");
  });

  it("handles an empty diff without crashing", () => {
    const p = buildProsePrompt("", docs);
    expect(p).toContain("(no reference changes)");
  });
});

describe("resolveDocPath (THE-477 hardening / audit #9)", () => {
  const root = resolve("/repo") + "/";

  it("accepts a repo-relative markdown file", () => {
    expect(resolveDocPath(root, "README.md")).toBe(resolve("/repo/README.md"));
    expect(resolveDocPath(root, "docs/ARCHITECTURE.md")).toBe(resolve("/repo/docs/ARCHITECTURE.md"));
    expect(resolveDocPath(root, " README.md ")).toBe(resolve("/repo/README.md")); // trims
  });

  it("refuses a path that escapes the repo root", () => {
    expect(resolveDocPath(root, "../../secret.md")).toBeNull();
    expect(resolveDocPath(root, "../secret.md")).toBeNull();
    expect(resolveDocPath(root, "docs/../../secret.md")).toBeNull();
  });

  it("refuses an absolute path", () => {
    expect(resolveDocPath(root, "/etc/passwd.md")).toBeNull();
  });

  it("refuses a non-markdown extension", () => {
    expect(resolveDocPath(root, "secret.txt")).toBeNull();
    expect(resolveDocPath(root, "config")).toBeNull();
    expect(resolveDocPath(root, ".env")).toBeNull();
  });

  it("refuses a hidden path segment", () => {
    expect(resolveDocPath(root, ".env.md")).toBeNull();
    expect(resolveDocPath(root, ".git/config.md")).toBeNull();
    expect(resolveDocPath(root, "docs/.secret.md")).toBeNull();
  });

  it("refuses empty entries", () => {
    expect(resolveDocPath(root, "")).toBeNull();
    expect(resolveDocPath(root, "   ")).toBeNull();
  });
});
