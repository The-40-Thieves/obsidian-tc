// prune_hub_links works on BODY links only. It used to scan the raw file, frontmatter included, so
// an unresolved property link was blanked to `""` (an edit of the user's properties) and a property
// link made a later body link count as a duplicate.
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { issueElicitToken } from "../src/elicit";
import { parseNote } from "../src/vault/frontmatter";
import { buildVaultIndex, extractNoteLinks } from "../src/vault/links";
import { pruneHubLinks } from "../src/vault/prune";
import { makeTestVault } from "./m1-helpers";

const INDEX = buildVaultIndex(["Real.md", "Other.md"]);
const BOTH = { removeUnresolved: true, removeDuplicates: true };

const FRONT =
  '---\nauthor: "[[Ghost]]"\nup: "[[Real]]"\nrelated:\n  - "[[Real]]"\n  - "[[Ghost2]]"\naliases: ["[[Ghost3|g]]"]\n---\n';

describe("pruneHubLinks leaves frontmatter alone", () => {
  it("an unresolved property link is not blanked; a duplicate body link is still removed", () => {
    const raw = `${FRONT}# Hub\n- [[Real]]\n- [[Real]]\n- [[Missing]]\n`;
    const { text, removed } = pruneHubLinks(raw, INDEX, BOTH);
    expect(text.startsWith(FRONT)).toBe(true);
    expect(text).toBe(`${FRONT}# Hub\n- [[Real]]\n`);
    // file lines: the frontmatter block is 8 lines, so the body's first line is line 9
    expect(removed).toEqual([
      { target: "Real", line: 11, reason: "duplicate" },
      { target: "Missing", line: 12, reason: "unresolved" },
    ]);
  });

  it("duplicates are counted from body links only: a property link to the target is not an earlier one", () => {
    const raw = `${FRONT}- [[Real]]\n`;
    const { text, removed } = pruneHubLinks(raw, INDEX, BOTH);
    expect(removed).toEqual([]);
    expect(text).toBe(raw);
  });

  it("a note whose only links are property links is a no-op", () => {
    const raw = `${FRONT}plain body\n`;
    expect(pruneHubLinks(raw, INDEX, BOTH)).toEqual({ text: raw, removed: [] });
  });

  it("CRLF frontmatter stays byte-identical", () => {
    const front = FRONT.replace(/\n/g, "\r\n");
    const raw = `${front}- [[Ghost]]\r\n- [[Other]]\r\n`;
    const { text } = pruneHubLinks(raw, INDEX, BOTH);
    expect(text).toBe(`${front}- [[Other]]\r\n`);
  });

  it("an LF body under CRLF frontmatter is not converted", () => {
    const front = '---\r\nup: "[[Ghost]]"\r\n---\r\n';
    const { text } = pruneHubLinks(`${front}- [[Ghost]]\n- [[Other]]\n`, INDEX, BOTH);
    expect(text).toBe(`${front}- [[Other]]\n`);
  });

  it("unparseable frontmatter is still left untouched", () => {
    const front = "---\nup: [[Ghost\n  bad: : :\n---\n";
    const { text } = pruneHubLinks(`${front}- [[Ghost]]\n- [[Other]]\n`, INDEX, BOTH);
    expect(text).toBe(`${front}- [[Other]]\n`);
  });

  it("a markdown link written in a property value is not touched", () => {
    const front = "---\nsrc: see [x](Gone.md)\n---\n";
    const { text } = pruneHubLinks(`${front}- [y](Gone.md)\n`, INDEX, BOTH);
    expect(text).toBe(`${front}- y\n`); // the body link collapses to its display text; the property stays
  });

  it("the links it prunes are the shared scanner's body-sourced links, never its property ones", () => {
    const raw = `${FRONT}- [[Real]]\n- [[Ghost]]\n`;
    const links = extractNoteLinks(parseNote(raw));
    const idx = buildVaultIndex(["Real.md"]);
    const unresolvedBody = links
      .filter((l) => (l.source ?? "body") === "body" && l.target === "Ghost")
      .map((l) => l.target);
    const { removed } = pruneHubLinks(raw, idx, BOTH);
    expect(removed.map((r) => r.target)).toEqual(unresolvedBody);
    // Ghost is also a PROPERTY link here, and Ghost2/Ghost3 are unresolved property links: none removed
    expect(
      links.filter((l) => l.source === "property" && !idx.byBasename.has(l.target.toLowerCase()))
        .length,
    ).toBeGreaterThan(0);
  });
});

describe("prune_hub_links tool", () => {
  const hashOf = (r: ToolResult): string => {
    if (r.ok) throw new Error("expected an error result");
    return String((r.error.details as { args_hash?: string }).args_hash);
  };

  it("a real run rewrites the body, keeps the properties byte-identical, reports file lines", async () => {
    const hub = `${FRONT}# Hub\n- [[Real]]\n- [[Ghost]]\n- [[Real]]\n`;
    const v = makeTestVault({ files: { "Real.md": "x", "hub.md": hub } });
    try {
      const input = { vault: "test", path: "hub.md", dry_run: false };
      const need = await v.call("prune_hub_links", input);
      const ok = await v.call("prune_hub_links", input, {
        elicitToken: issueElicitToken(v.db, {
          vaultId: v.id,
          toolName: "prune_hub_links",
          argsHash: hashOf(need),
          caller: "test",
        }),
      });
      expect(ok.ok).toBe(true);
      if (ok.ok) {
        const d = ok.data as { removed_count: number; removed: Array<{ line: number }> };
        expect(d.removed_count).toBe(2);
        expect(d.removed.map((r) => r.line)).toEqual([11, 12]);
      }
      expect(v.read("hub.md")).toBe(`${FRONT}# Hub\n- [[Real]]\n`);
    } finally {
      v.cleanup();
    }
  });
});
