// THE-1038: patch_note anchor correctness (GH #922, #926) — every repro string quoted in those
// issues becomes a test case here, at the tool level (through patch_note/read_note), rather than
// unit tests on notes/anchors.ts's internals directly, so a regression is caught exactly where a
// caller would see it.
import { describe, expect, it } from "vitest";
import { makeTestVault } from "./m1-helpers";

describe("GH #927: read_note section read", () => {
  // Lines (1-based) in the raw file:
  // 1 ---            2 title: Test     3 ---
  // 4 intro text     5 # One           6 first section
  // 7 para with ref ^blk1              8 # Two          9 second
  const raw = [
    "---",
    "title: Test",
    "---",
    "intro text",
    "# One",
    "first section",
    "para with ref ^blk1",
    "# Two",
    "second",
  ].join("\n");

  it("returns the preamble for a frontmatter anchor, with raw-file line numbers", async () => {
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("read_note", {
        vault: "test",
        path: "a.md",
        anchor: { type: "frontmatter" },
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as {
          section?: { text: string; start_line: number; end_line: number };
          content_hash: string;
        };
        expect(d.section).toEqual({ text: "intro text", start_line: 4, end_line: 4 });
        // content_hash is the WHOLE-note hash so it round-trips into patch_note's prev_hash.
        const whole = await v.call("read_note", { vault: "test", path: "a.md" });
        expect(whole.ok && (whole.data as { content_hash: string }).content_hash).toBe(
          d.content_hash,
        );
      }
    } finally {
      v.cleanup();
    }
  });

  it("returns the section INCLUDING its heading line for a heading anchor", async () => {
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("read_note", {
        vault: "test",
        path: "a.md",
        anchor: { type: "heading", heading: "One" },
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as {
          section?: { text: string; start_line: number; end_line: number; heading_level?: number };
        };
        expect(d.section).toEqual({
          text: "# One\nfirst section\npara with ref ^blk1",
          start_line: 5,
          end_line: 7,
          heading_level: 1,
        });
      }
    } finally {
      v.cleanup();
    }
  });

  it("returns the paragraph for a block anchor, with no heading_level", async () => {
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("read_note", {
        vault: "test",
        path: "a.md",
        anchor: { type: "block", block_id: "blk1" },
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as { section?: Record<string, unknown> };
        expect(d.section).toEqual({
          text: "first section\npara with ref ^blk1",
          start_line: 6,
          end_line: 7,
        });
        expect(d.section).not.toHaveProperty("heading_level");
      }
    } finally {
      v.cleanup();
    }
  });

  it("omits section (not null) when no anchor is given", async () => {
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("read_note", { vault: "test", path: "a.md" });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data).not.toHaveProperty("section");
    } finally {
      v.cleanup();
    }
  });

  it("anchor not found -> invalid_input, matching patch_note's message", async () => {
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const heading = await v.call("read_note", {
        vault: "test",
        path: "a.md",
        anchor: { type: "heading", heading: "Ghost" },
      });
      expect(heading.ok).toBe(false);
      if (!heading.ok) {
        expect(heading.error.code).toBe("invalid_input");
        expect(heading.error.message).toBe("target heading not found");
      }
      const block = await v.call("read_note", {
        vault: "test",
        path: "a.md",
        anchor: { type: "block", block_id: "ghost" },
      });
      expect(block.ok).toBe(false);
      if (!block.ok) expect(block.error.message).toBe("block reference not found");
    } finally {
      v.cleanup();
    }
  });

  it("an ambiguous anchor is refused the same way patch_note refuses it", async () => {
    const v = makeTestVault({ files: { "a.md": "## A\nold\n## A\nkeep" } });
    try {
      const r = await v.call("read_note", {
        vault: "test",
        path: "a.md",
        anchor: { type: "heading", heading: "A" },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("invalid_input");
        expect(r.error.details).toMatchObject({ count: 2, lines: [1, 3] });
      }
    } finally {
      v.cleanup();
    }
  });

  it("a CRLF note's section text keeps CRLF line endings", async () => {
    const crlf = "# One\r\nfirst\r\nsecond\r\n# Two\r\nkeep\r\n";
    const v = makeTestVault({ files: { "a.md": crlf } });
    try {
      const r = await v.call("read_note", {
        vault: "test",
        path: "a.md",
        anchor: { type: "heading", heading: "One" },
      });
      expect(r.ok).toBe(true);
      if (r.ok)
        expect((r.data as { section?: { text: string } }).section?.text).toBe(
          "# One\r\nfirst\r\nsecond",
        );
    } finally {
      v.cleanup();
    }
  });
});

describe("GH #928: patch_note operation replace_text", () => {
  it("replaces a unique exact string within the resolved section", async () => {
    const raw = ["## A", "the old value stays", "## B", "the old value stays"].join("\n");
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace_text",
        target_heading: "A",
        old_string: "old value",
        new_string: "NEW VALUE",
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const d = r.data as {
          operation: string;
          lines_removed: number;
          bytes_removed: number;
        };
        expect(d.operation).toBe("replace_text");
        expect(d.lines_removed).toBe(1);
        expect(d.bytes_removed).toBe(Buffer.byteLength("old value"));
      }
      // Only the occurrence inside ## A's section changed; ## B's is untouched.
      expect(v.read("a.md")).toBe(
        ["## A", "the NEW VALUE stays", "## B", "the old value stays"].join("\n"),
      );
    } finally {
      v.cleanup();
    }
  });

  it("0 matches -> invalid_input 'old_string not found in section'", async () => {
    const raw = ["## A", "content", "## B", "keep"].join("\n");
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace_text",
        target_heading: "A",
        old_string: "ghost",
        new_string: "x",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("invalid_input");
        expect(r.error.message).toBe("old_string not found in section");
      }
      expect(v.read("a.md")).toBe(raw);
    } finally {
      v.cleanup();
    }
  });

  it("2+ matches -> invalid_input with the count", async () => {
    const raw = ["## A", "dup dup dup", "## B", "keep"].join("\n");
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace_text",
        target_heading: "A",
        old_string: "dup",
        new_string: "x",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("invalid_input");
        expect(r.error.details).toMatchObject({ count: 3 });
      }
      expect(v.read("a.md")).toBe(raw);
    } finally {
      v.cleanup();
    }
  });

  it("a match outside the anchor's section is out of scope (0 matches)", async () => {
    const raw = ["## A", "content", "## B", "the target text"].join("\n");
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace_text",
        target_heading: "A",
        old_string: "target",
        new_string: "x",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toBe("old_string not found in section");
    } finally {
      v.cleanup();
    }
  });

  it("confirm_replace is ignored: a large removal via replace_text is never gated", async () => {
    const big = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    const raw = `## A\n${big}`;
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace_text",
        target_heading: "A",
        old_string: big,
        new_string: "x",
      });
      expect(r.ok).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("prev_hash is still enforced for replace_text", async () => {
    const raw = ["## A", "old value", "## B", "keep"].join("\n");
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace_text",
        target_heading: "A",
        old_string: "old value",
        new_string: "new value",
        prev_hash: "0".repeat(64),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("concurrent_modification");
    } finally {
      v.cleanup();
    }
  });

  it("schema: old_string/new_string required for replace_text; content required otherwise", async () => {
    const v = makeTestVault({ files: { "a.md": "## A\nx" } });
    try {
      const missingOldString = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace_text",
        target_heading: "A",
        new_string: "y",
      });
      expect(missingOldString.ok).toBe(false);
      if (!missingOldString.ok) expect(missingOldString.error.code).toBe("validation_error");

      const missingContent = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        target_heading: "A",
      });
      expect(missingContent.ok).toBe(false);
      if (!missingContent.ok) expect(missingContent.error.code).toBe("validation_error");
    } finally {
      v.cleanup();
    }
  });
});

describe("GH #922 shape 2: replace is idempotent on the anchor heading", () => {
  it("drops a duplicate leading heading from replace content (verbatim repro)", async () => {
    const raw = ["## A", "old", "## B", "keep"].join("\n");
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace",
        target_heading: "A",
        content: "## A\nnew",
      });
      expect(r.ok).toBe(true);
      const out = v.read("a.md");
      expect(out).toBe("## A\nnew\n## B\nkeep");
      expect((out.match(/^## A$/gm) ?? []).length).toBe(1);
    } finally {
      v.cleanup();
    }
  });

  it("keeps content that does not repeat the anchor heading unchanged", async () => {
    const raw = ["## A", "old", "## B", "keep"].join("\n");
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace",
        target_heading: "A",
        content: "just new content",
      });
      expect(r.ok).toBe(true);
      expect(v.read("a.md")).toBe("## A\njust new content\n## B\nkeep");
    } finally {
      v.cleanup();
    }
  });

  it("does not drop a heading of a DIFFERENT level or text", async () => {
    const raw = ["## A", "old", "## B", "keep"].join("\n");
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace",
        target_heading: "A",
        content: "### A\nnew",
      });
      expect(r.ok).toBe(true);
      // level mismatch (### vs ##) — the heading in content is content, not a duplicate.
      expect(v.read("a.md")).toBe("## A\n### A\nnew\n## B\nkeep");
    } finally {
      v.cleanup();
    }
  });

  it("does not apply the drop for append/prepend, only replace", async () => {
    const raw = ["## A", "old", "## B", "keep"].join("\n");
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        target_heading: "A",
        content: "## A\nnew",
      });
      expect(r.ok).toBe(true);
      expect(v.read("a.md")).toBe("## A\nold\n## A\nnew\n## B\nkeep");
    } finally {
      v.cleanup();
    }
  });
});

describe("GH #926: fence-aware heading scan", () => {
  it("ends a section at the real next heading, not one hidden inside a fenced code block", async () => {
    // Adapted from the issue's repro: a fenced sample block containing `## Platform Links` must
    // not bound the "Release template" section — an append must land at the REAL next heading
    // (## Next section), not right after the fenced sample (the old bug's line index 5).
    const raw = [
      "# Probe",
      "",
      "## Release template",
      "",
      "Use this block when publishing:",
      "",
      "```markdown",
      "## Platform Links",
      "- Spotify:",
      "- Apple:",
      "```",
      "",
      "Remember to update the index after publishing.",
      "",
      "## Next section",
      "",
      "content here",
    ].join("\n");
    const v = makeTestVault({ files: { "probe.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "probe.md",
        operation: "append",
        target_heading: "Release template",
        content: "NEW",
      });
      expect(r.ok).toBe(true);
      const out = v.read("probe.md");
      // NEW lands right before the real next heading, after the fenced sample and the trailing
      // paragraph both stayed untouched — not right after the fenced `## Platform Links`.
      expect(out).toContain(
        "Remember to update the index after publishing.\n\nNEW\n## Next section",
      );
      expect(out).toContain("## Platform Links");
      // The fence the append never touched is still a properly paired open/close.
      expect((out.match(/```/g) ?? []).length).toBe(2);
    } finally {
      v.cleanup();
    }
  });

  it("does not bind an anchor to a heading that only exists as sample text inside a fence", async () => {
    const raw = ["# Doc", "", "```md", "## Target", "sample", "```", "", "## Real", "keep"].join(
      "\n",
    );
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace",
        target_heading: "Target",
        content: "x",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
      expect(v.read("a.md")).toBe(raw);
    } finally {
      v.cleanup();
    }
  });

  it("a fence character nested inside a different fence type is content, not a close", async () => {
    // A ``` line inside a ~~~ block must not close the ~~~ fence early.
    const raw = ["## A", "~~~text", "```", "still inside", "~~~", "## B", "tail"].join("\n");
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        target_heading: "A",
        content: "NEW",
      });
      expect(r.ok).toBe(true);
      // append lands at the end of A's section — right before ## B — not mid-fence.
      expect(v.read("a.md")).toContain("~~~\nNEW\n## B");
    } finally {
      v.cleanup();
    }
  });
});

describe("GH #922 shape 3: ambiguous anchor is refused, not first-match-bound", () => {
  it("refuses a heading anchor that matches more than one line, with the count and 1-based lines", async () => {
    // Exactly what shape 2 (idempotent replace, next commit) can produce today: two identical
    // adjacent headings. The next replace on "A" must refuse rather than silently bind to the
    // first copy and double the body.
    const raw = ["## A", "old", "## A", "keep"].join("\n");
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace",
        target_heading: "A",
        content: "new body",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("invalid_input");
        expect(r.error.details).toMatchObject({ count: 2, lines: [1, 3] });
      }
      expect(v.read("a.md")).toBe(raw);
    } finally {
      v.cleanup();
    }
  });

  it("matches headings case-insensitively and by trimmed text when counting ambiguity", async () => {
    const raw = ["## Notes", "one", "##   notes  ", "two"].join("\n");
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        target_heading: "notes",
        content: "x",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.details).toMatchObject({ count: 2 });
    } finally {
      v.cleanup();
    }
  });

  it("refuses a block id that occurs on more than one line", async () => {
    const raw = ["para one ^dup", "para two ^dup"].join("\n");
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        anchor: { type: "block", block_id: "dup" },
        content: "x",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("invalid_input");
        expect(r.error.details).toMatchObject({ count: 2, lines: [1, 2] });
      }
    } finally {
      v.cleanup();
    }
  });

  it("a heading that only exists inside a fence does not count toward ambiguity", async () => {
    const raw = ["## A", "old", "```", "## A", "```", "## B", "keep"].join("\n");
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace",
        target_heading: "A",
        content: "new",
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(v.read("a.md")).toContain("## A\nnew\n## B");
    } finally {
      v.cleanup();
    }
  });
});

describe("GH #926 suggested guard: odd fence-delimiter count is refused", () => {
  it("refuses a replace that would leave an unterminated fence", async () => {
    // Before: a properly closed fence lives entirely inside ## B's section (2 delimiters, even).
    // The replace targets ## A (unrelated) with content that opens a fence and never closes it,
    // flipping the WHOLE body's delimiter count from 2 (even) to 3 (odd).
    const raw = ["## A", "old", "## B", "```", "fenced", "```", "keep"].join("\n");
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace",
        target_heading: "A",
        content: "```\nno closing fence here",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("invalid_input");
        expect(r.error.message).toMatch(/unterminated code fence/);
      }
      expect(v.read("a.md")).toBe(raw);
    } finally {
      v.cleanup();
    }
  });

  it("does not refuse a patch on a note that already has an unclosed fence elsewhere", async () => {
    const raw = ["## A", "old", "## B", "```", "already broken"].join("\n");
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace",
        target_heading: "A",
        content: "new",
      });
      expect(r.ok).toBe(true);
      expect(v.read("a.md")).toContain("## A\nnew\n## B");
    } finally {
      v.cleanup();
    }
  });
});
