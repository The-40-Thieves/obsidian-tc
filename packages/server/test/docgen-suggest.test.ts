// docgen prose suggestion (THE-477): the prompt builder is pure + testable without a gateway. The
// LLM call + git wiring stay out of the test (advisory tool, operator-run).
import { describe, expect, it } from "vitest";
import { buildProsePrompt } from "../scripts/docgen/suggest-prose";

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
