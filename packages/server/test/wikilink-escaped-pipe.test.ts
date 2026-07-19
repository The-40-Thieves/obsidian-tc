// Regression: GH #279 — escaped-pipe wikilinks in tables ([[note\|alias]]).
// Obsidian requires the alias pipe to be escaped inside a markdown table and
// treats "\|" as the alias separator. The old indexOf("|") split matched the pipe
// of "\|" and left the backslash on the target, so it resolved to nothing —
// inflating find_unresolved_links / find_orphans / vault_health_score, and (in the
// writer) risking table corruption on move.
import { describe, expect, it } from "vitest";
import { buildVaultIndex, extractLinks, resolveTarget } from "../src/vault/links";
import { pruneHubLinks } from "../src/vault/prune";
import { rewriteLinks } from "../src/vault/rewrite";

describe("escaped-pipe wikilinks (GH #279)", () => {
  it("extractLinks treats \\| as the alias separator and resolves the target", () => {
    const table = "| Note | Why |\n|---|---|\n| [[Some/Note\\|The Target]] | row |\n";
    const wl = extractLinks(table).filter((l) => l.kind === "wikilink");
    expect(wl).toHaveLength(1);
    expect(wl[0]?.target).toBe("Some/Note");
    expect(wl[0]?.display).toBe("The Target");
    const index = buildVaultIndex(["Some/Note.md"]);
    expect(resolveTarget(index, wl[0]?.target ?? "").resolved).toBe(true);
  });

  it("extractLinks still handles a plain (unescaped) pipe", () => {
    const [wl] = extractLinks("[[Note|Alias]]");
    expect(wl?.target).toBe("Note");
    expect(wl?.display).toBe("Alias");
  });

  it("extractLinks keeps heading and an escaped-pipe alias distinct", () => {
    const [wl] = extractLinks("[[Note#Section\\|Alias]]");
    expect(wl?.target).toBe("Note");
    expect(wl?.heading).toBe("Section");
    expect(wl?.display).toBe("Alias");
  });

  it("rewriteLinks preserves the escaped pipe so the table row stays valid", () => {
    const { text, count } = rewriteLinks("| [[Old/Note\\|Alias]] |", (t) =>
      t === "Old/Note" ? "New/Note" : null,
    );
    expect(count).toBe(1);
    expect(text).toBe("| [[New/Note\\|Alias]] |");
  });

  it("rewriteLinks leaves a plain pipe unescaped", () => {
    const { text } = rewriteLinks("[[Old|Alias]]", (t) => (t === "Old" ? "New" : null));
    expect(text).toBe("[[New|Alias]]");
  });

  it("pruneHubLinks does not treat an escaped-pipe link to a real note as unresolved", () => {
    const index = buildVaultIndex(["Target.md"]);
    const raw = "- [[Target\\|shown]]\n";
    const res = pruneHubLinks(raw, index, { removeUnresolved: true, removeDuplicates: false });
    expect(res.removed).toHaveLength(0);
    expect(res.text).toBe(raw);
  });
});
