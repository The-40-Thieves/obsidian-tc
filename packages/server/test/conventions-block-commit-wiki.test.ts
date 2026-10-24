// commit_wiki_page under a `severity: block` folder rule: a page that breaks the rule is refused before
// any snapshot or temp file, so the batch writes nothing (the whole commit is one unit).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeWikiHarness } from "./wiki-test-helpers";

const WIKI_SCHEMA =
  "---\nconventions:\n  frontmatter:\n    required: [type]\n    severity: { type: block }\n---\n# rules\n";

describe("commit_wiki_page under a block rule", () => {
  it("refuses a page that breaks the block rule and writes no page", async () => {
    const hh = makeWikiHarness({
      files: { "wiki/SCHEMA.md": WIKI_SCHEMA },
      wikiFolder: "wiki",
      centralAcl: true,
      conventions: true,
    });
    try {
      const r = await hh.v.call("commit_wiki_page", {
        vault: "test",
        topic: "Learning techniques",
        type: "concept",
        page: {
          path: "wiki/learning.md",
          frontmatter: { summary: "How to learn" },
          body: "# Learning techniques\n",
        },
        patches: [],
      });
      expect(r.ok ? "ok" : r.error.code).toBe("convention_blocked");
      expect(existsSync(join(hh.v.root, "wiki/learning.md"))).toBe(false);
    } finally {
      hh.v.cleanup();
    }
  });
});
