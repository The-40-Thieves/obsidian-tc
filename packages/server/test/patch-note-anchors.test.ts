// THE-1038: patch_note anchor correctness (GH #922, #926) — every repro string quoted in those
// issues becomes a test case here, at the tool level (through patch_note/read_note), rather than
// unit tests on notes/anchors.ts's internals directly, so a regression is caught exactly where a
// caller would see it.
import { describe, expect, it } from "vitest";
import { makeTestVault } from "./m1-helpers";

type Section = { text: string; start_line: number; end_line: number; heading_level?: number };

/** Proves start_line/end_line against the RAW file content, per the review's own formula.
 *  Review round 2 T5: joins with the note's OWN eol (not a hardcoded "\n"), so this is a real
 *  proof on a CRLF note too, not just LF ones. */
function assertLineNumbersMatch(content: string, section: Section): void {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const rawLines = content.split(/\r?\n/);
  const recomputed = rawLines.slice(section.start_line - 1, section.end_line).join(eol);
  expect(recomputed).toBe(section.text);
}

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

  it("a CRLF note's section text keeps CRLF line endings, with proven line numbers", async () => {
    // Review round 2 T5: the line-number invariant is now applied here too, not just to LF notes.
    const crlf = "# One\r\nfirst\r\nsecond\r\n# Two\r\nkeep\r\n";
    const v = makeTestVault({ files: { "a.md": crlf } });
    try {
      const r = await v.call("read_note", {
        vault: "test",
        path: "a.md",
        anchor: { type: "heading", heading: "One" },
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const section = (r.data as { section?: Section }).section as Section;
        expect(section).toEqual({
          text: "# One\r\nfirst\r\nsecond",
          start_line: 1,
          end_line: 3,
          heading_level: 1,
        });
        assertLineNumbersMatch(crlf, section);
      }
    } finally {
      v.cleanup();
    }
  });
});

describe("Review round 1 C1: read_note section line numbers", () => {
  it("C1(a): an empty preamble reports start_line === end_line, never end_line < start_line", async () => {
    const raw = "---\ntitle: x\n---\n# H\nbody\n";
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("read_note", {
        vault: "test",
        path: "a.md",
        anchor: { type: "frontmatter" },
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const section = (r.data as { section?: Section }).section as Section;
        expect(section.text).toBe("");
        expect(section.end_line).toBeGreaterThanOrEqual(section.start_line);
        // The chosen empty-section convention (documented on ReadNoteSectionOut): both name the
        // raw line the section is anchored before — "# H" is raw line 4.
        expect(section).toEqual({ text: "", start_line: 4, end_line: 4 });
      }
    } finally {
      v.cleanup();
    }
  });

  it("C1(b): an empty frontmatter block still occupies a raw line — offset is not zeroed", async () => {
    const raw = "---\n\n---\n# H\nbody\n";
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("read_note", {
        vault: "test",
        path: "a.md",
        anchor: { type: "heading", heading: "H" },
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const section = (r.data as { section?: Section }).section as Section;
        // "# H" is raw line 4 (---, <blank>, ---, # H), not raw line 3.
        expect(section.start_line).toBe(4);
        assertLineNumbersMatch(raw, section);
      }
    } finally {
      v.cleanup();
    }
  });

  it("C1(c): a trailing newline's phantom split() element is not counted as a real line", async () => {
    const raw = "# Only\na\n";
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("read_note", {
        vault: "test",
        path: "a.md",
        anchor: { type: "heading", heading: "Only" },
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const section = (r.data as { section?: Section }).section as Section;
        // The file has exactly 2 real lines; end_line must not reach a phantom 3rd.
        expect(section.end_line).toBe(2);
        expect(section.text).toBe("# Only\na");
        assertLineNumbersMatch(raw, section);
      }
    } finally {
      v.cleanup();
    }
  });

  it("a non-empty preamble running to EOF with a trailing newline excludes the phantom line", async () => {
    // No heading at all: the preamble is the WHOLE body, ending at real EOF.
    const raw = "intro one\nintro two\n";
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("read_note", {
        vault: "test",
        path: "a.md",
        anchor: { type: "frontmatter" },
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const section = (r.data as { section?: Section }).section as Section;
        expect(section).toEqual({ text: "intro one\nintro two", start_line: 1, end_line: 2 });
        assertLineNumbersMatch(raw, section);
      }
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

  it("surfaces the snapshot no-op for replace_text when snapshots are disabled, like replace", async () => {
    const raw = ["## A", "old value", "## B", "keep"].join("\n");
    const skipped: Array<{ vaultId: string; path: string; op: string }> = [];
    const v = makeTestVault({
      files: { "a.md": raw },
      snapshots: { enabled: false, retention: 10 },
      onSnapshotSkipped: (vaultId, path, op) => skipped.push({ vaultId, path, op }),
    });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace_text",
        target_heading: "A",
        old_string: "old value",
        new_string: "new value",
      });
      expect(r.ok).toBe(true);
      expect(skipped).toEqual([{ vaultId: "test", path: "a.md", op: "patch_note" }]);
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

  it("verbatim #926 repro: replace on the section correctly consumes the whole section, orphaning no fence", async () => {
    // The issue's exact repro call. The section-end fix means `replace` now legitimately consumes
    // the fenced sample and the trailing paragraph too — they are genuinely part of "Release
    // template"'s section, unlike the pre-fix bug which stopped mid-fence and left it orphaned.
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
        operation: "replace",
        target_heading: "Release template",
        confirm_replace: false,
        content: "\nREPLACED\n",
      });
      expect(r.ok).toBe(true);
      const out = v.read("probe.md");
      expect(out).toBe(
        [
          "# Probe",
          "",
          "## Release template",
          "",
          "REPLACED",
          "",
          "## Next section",
          "",
          "content here",
        ].join("\n"),
      );
      // No orphaned fence: the fenced sample was entirely inside the replaced section.
      expect((out.match(/```/g) ?? []).length).toBe(0);
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

describe("a CRLF note keeps its EOL across every patch_note operation", () => {
  const crlf = "## A\r\nold\r\n## B\r\nkeep\r\n";

  it("append preserves CRLF", async () => {
    const v = makeTestVault({ files: { "a.md": crlf } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        target_heading: "A",
        content: "NEW",
      });
      expect(r.ok).toBe(true);
      const out = v.read("a.md");
      expect(out).toBe("## A\r\nold\r\nNEW\r\n## B\r\nkeep\r\n");
      expect(out).not.toMatch(/[^\r]\n/);
    } finally {
      v.cleanup();
    }
  });

  it("replace preserves CRLF", async () => {
    const v = makeTestVault({ files: { "a.md": crlf } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace",
        target_heading: "A",
        content: "new",
      });
      expect(r.ok).toBe(true);
      const out = v.read("a.md");
      expect(out).toBe("## A\r\nnew\r\n## B\r\nkeep\r\n");
      expect(out).not.toMatch(/[^\r]\n/);
    } finally {
      v.cleanup();
    }
  });

  it("replace_text preserves CRLF", async () => {
    const v = makeTestVault({ files: { "a.md": crlf } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace_text",
        target_heading: "A",
        old_string: "old",
        new_string: "changed",
      });
      expect(r.ok).toBe(true);
      const out = v.read("a.md");
      expect(out).toBe("## A\r\nchanged\r\n## B\r\nkeep\r\n");
      expect(out).not.toMatch(/[^\r]\n/);
    } finally {
      v.cleanup();
    }
  });
});

describe("Review round 1 I2/M8 + round 2 Codex: CommonMark-correct fence closing", () => {
  it("I2: a shorter closer inside a longer fence does not close it; the real close does", async () => {
    // Verbatim shape from #926's own issue body (a 4-backtick wrapper around a 3-backtick sample).
    const raw = ["## A", "````", "```", "## Inside", "```", "````", "## B"].join("\n");
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
      // The section correctly extends past the inner 3-backtick lines and "## Inside" (all
      // content inside the outer 4-backtick fence) and lands right before the real "## B".
      expect(v.read("a.md")).toBe(
        ["## A", "````", "```", "## Inside", "```", "````", "NEW", "## B"].join("\n"),
      );
    } finally {
      v.cleanup();
    }
  });

  it("M8 / Codex: a fence delimiter indented 4+ spaces is content, not a fence delimiter", async () => {
    // Codex's exact repro: a 4-space-indented ``` must not open a fence, or the real ## B is
    // hidden and the whole tail of the note is swallowed by the next replace/append.
    const raw = "## A\nold\n\n    ```\n\n## B\nkeep";
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
      // The indented ``` never opened a fence, so ## B is a real boundary and survives untouched.
      expect(v.read("a.md")).toBe("## A\nnew\n## B\nkeep");
    } finally {
      v.cleanup();
    }
  });

  it("Codex: a closer with trailing text after the delimiter run does not close the fence", async () => {
    const raw = [
      "## A",
      "```",
      "inside",
      "``` trailing",
      "more inside",
      "```",
      "## B",
      "keep",
    ].join("\n");
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
      // "``` trailing" (trailing text after the run) is not a valid closer — content survives,
      // the REAL closer (bare ```) ends the fence, and NEW lands right before the real ## B.
      expect(v.read("a.md")).toBe(
        ["## A", "```", "inside", "``` trailing", "more inside", "```", "NEW", "## B", "keep"].join(
          "\n",
        ),
      );
    } finally {
      v.cleanup();
    }
  });
});

describe("Review round 1 I4: replace_text preserves the anchor heading line", () => {
  it("refuses to match the heading line itself — old_string not found in section", async () => {
    const raw = "## A\nold value\n## B\nkeep";
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace_text",
        target_heading: "A",
        old_string: "## A",
        new_string: "",
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

  it("still matches ordinary body text within the same heading section", async () => {
    const raw = "## A\nold value\n## B\nkeep";
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace_text",
        target_heading: "A",
        old_string: "old value",
        new_string: "new value",
      });
      expect(r.ok).toBe(true);
      expect(v.read("a.md")).toBe("## A\nnew value\n## B\nkeep");
    } finally {
      v.cleanup();
    }
  });
});

describe("Review round 1 M5 / round 2 N2: a fenced block-id marker is never a candidate", () => {
  const raw = ["para one ^dup", "```", "sample ^dup", "```", "keep"].join("\n");

  it("patch_note resolves to the real (non-fenced) block, not ambiguous", async () => {
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        anchor: { type: "block", block_id: "dup" },
        content: "AFTER",
      });
      expect(r.ok).toBe(true);
      expect(v.read("a.md")).toBe(
        ["para one ^dup", "AFTER", "```", "sample ^dup", "```", "keep"].join("\n"),
      );
    } finally {
      v.cleanup();
    }
  });

  it("a block-id marker that ONLY exists inside a fence is 'not found', not resolved into the fence", async () => {
    const fencedOnly = ["intro", "```", "sample ^ghost", "```", "keep"].join("\n");
    const v = makeTestVault({ files: { "a.md": fencedOnly } });
    try {
      const patch = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        anchor: { type: "block", block_id: "ghost" },
        content: "x",
      });
      expect(patch.ok).toBe(false);
      if (!patch.ok) expect(patch.error.message).toBe("block reference not found");

      const read = await v.call("read_note", {
        vault: "test",
        path: "a.md",
        anchor: { type: "block", block_id: "ghost" },
      });
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.error.message).toBe("block reference not found");
    } finally {
      v.cleanup();
    }
  });

  it("read_note resolves to the real (non-fenced) block's paragraph text", async () => {
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("read_note", {
        vault: "test",
        path: "a.md",
        anchor: { type: "block", block_id: "dup" },
      });
      expect(r.ok).toBe(true);
      if (r.ok)
        expect((r.data as { section?: { text: string } }).section?.text).toBe("para one ^dup");
    } finally {
      v.cleanup();
    }
  });
});

describe("Review round 1 M6: replace_text/content are mutually exclusive by operation", () => {
  it("old_string/new_string on a non-replace_text operation is validation_error", async () => {
    const v = makeTestVault({ files: { "a.md": "## A\nx" } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        target_heading: "A",
        content: "y",
        old_string: "z",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("validation_error");
    } finally {
      v.cleanup();
    }
  });

  it("content on replace_text is validation_error", async () => {
    const v = makeTestVault({ files: { "a.md": "## A\nx" } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace_text",
        target_heading: "A",
        old_string: "x",
        new_string: "y",
        content: "unexpected",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("validation_error");
    } finally {
      v.cleanup();
    }
  });
});

describe("Review round 1 M7 / I3: replace_text matching correctness", () => {
  it("M7: overlapping matches are counted with a 1-character advance, not skipped", async () => {
    // "aa" occurs at position 0 and 1 within "aaa" — 2 overlapping matches, refused as ambiguous.
    const raw = "## A\naaa\n## B\nkeep";
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace_text",
        target_heading: "A",
        old_string: "aa",
        new_string: "x",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("invalid_input");
        expect(r.error.details).toMatchObject({ count: 2 });
      }
      expect(v.read("a.md")).toBe(raw);
    } finally {
      v.cleanup();
    }
  });

  it("I3: a multi-line old_string authored with \\n matches inside a CRLF note", async () => {
    const raw = "## A\r\nline one\r\nline two\r\n## B\r\nkeep\r\n";
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace_text",
        target_heading: "A",
        old_string: "line one\nline two",
        new_string: "replaced",
      });
      expect(r.ok).toBe(true);
      const out = v.read("a.md");
      expect(out).toBe("## A\r\nreplaced\r\n## B\r\nkeep\r\n");
      expect(out).not.toMatch(/[^\r]\n/);
    } finally {
      v.cleanup();
    }
  });
});

describe("Review round 2 N1: replace_text inserts new_string literally, not as a $-pattern", () => {
  it("$&, $$, $1 in new_string are written verbatim", async () => {
    const raw = "## A\nold\n## B\nkeep";
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace_text",
        target_heading: "A",
        old_string: "old",
        new_string: "$& $$ $1",
      });
      expect(r.ok).toBe(true);
      expect(v.read("a.md")).toBe("## A\n$& $$ $1\n## B\nkeep");
    } finally {
      v.cleanup();
    }
  });

  it("old_string === new_string containing $ is a byte-for-byte no-op", async () => {
    // "$$" is one of the patterns String.replace expands even with NO regex capture groups (it
    // collapses to a single literal "$") — a "$5" probe would pass by coincidence even with the
    // bug, since a bare $-digit with no capture groups is left alone either way.
    const raw = "## A\nprice is $$ today\n## B\nkeep";
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace_text",
        target_heading: "A",
        old_string: "price is $$ today",
        new_string: "price is $$ today",
      });
      expect(r.ok).toBe(true);
      expect(v.read("a.md")).toBe(raw);
    } finally {
      v.cleanup();
    }
  });
});

describe("Review round 2 N3: replace_text wiring parity with replace", () => {
  it("captures a snapshot when snapshots are enabled", async () => {
    const raw = "## A\nold\n## B\nkeep";
    const v = makeTestVault({ files: { "a.md": raw }, snapshots: { enabled: true, retention: 5 } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace_text",
        target_heading: "A",
        old_string: "old",
        new_string: "new",
      });
      expect(r.ok).toBe(true);
      const rows = v.db
        .prepare("SELECT COUNT(*) AS n FROM note_snapshots WHERE vault_id = ? AND path = ?")
        .get("test", "a.md") as { n: number };
      expect(rows.n).toBeGreaterThan(0);
    } finally {
      v.cleanup();
    }
  });

  it("invokes reindex with the new content", async () => {
    const raw = "## A\nold\n## B\nkeep";
    const reindexed: Array<{ path: string; content: string }> = [];
    const v = makeTestVault({
      files: { "a.md": raw },
      reindex: (_vaultId, path, content) => reindexed.push({ path, content }),
    });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace_text",
        target_heading: "A",
        old_string: "old",
        new_string: "new",
      });
      expect(r.ok).toBe(true);
      expect(reindexed).toHaveLength(1);
      expect(reindexed[0]?.path).toBe("a.md");
      expect(reindexed[0]?.content).toContain("new");
      expect(reindexed[0]?.content).not.toContain("old");
    } finally {
      v.cleanup();
    }
  });
});

describe("Review round 3 G1/G2: CommonMark fence-recognition edge cases", () => {
  it("G1: a TAB-indented fence delimiter is content (a tab expands to a 4-column stop)", async () => {
    // A leading tab is 4 columns of indentation per CommonMark, same as 4 spaces — content, not
    // a fence. Without column-aware indentation, this masks ## B and a replace on A consumes
    // the rest of the note.
    const raw = "## A\nold\n\t```\nmore\n## B\nkeep";
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
      expect(v.read("a.md")).toBe("## A\nnew\n## B\nkeep");
    } finally {
      v.cleanup();
    }
  });

  it("G2: a backtick fence opener whose info string contains a backtick is not a valid fence", async () => {
    // Verbatim shape from the review: the backtick run's info string ("js`x`") itself contains a
    // backtick, which CommonMark disallows for backtick fences — the line is ordinary text, so
    // ## B remains a real, live heading and the odd-fence guard must not fire.
    const raw = "## A\n```js`x`\ntext\n## B\nkeep";
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
      expect(v.read("a.md")).toBe("## A\n```js`x`\ntext\nNEW\n## B\nkeep");
      // ## B survives as a real, independently-resolvable heading.
      const r2 = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        target_heading: "B",
        content: "TAIL",
      });
      expect(r2.ok).toBe(true);
      if (r2.ok) expect((r2.data as { lines_removed: number }).lines_removed).toBe(0);
    } finally {
      v.cleanup();
    }
  });

  it("G2: a TILDE fence opener's info string MAY contain a backtick (tildes are exempt)", async () => {
    const raw = "## A\n~~~js`x`\n## FakeInside\n~~~\n## B\nkeep";
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
      // The tilde fence validly opened (backtick in info string is fine for ~~~), so
      // "## FakeInside" stayed masked and NEW lands right before the real ## B.
      expect(v.read("a.md")).toBe("## A\n~~~js`x`\n## FakeInside\n~~~\nNEW\n## B\nkeep");
    } finally {
      v.cleanup();
    }
  });
});

describe("Review round 3 B1: block paragraph-start walk stops at a fence boundary", () => {
  // Codex re-check: with a fenced ^id no longer a resolution candidate (M5/N2), the primary
  // match on the real (non-fenced) ^dup is found, but the paragraph-start walk previously
  // crossed the fence boundary above it, treating the fenced example as part of the "paragraph" —
  // a replace on the real block deleted the fenced example too.
  const raw = "## A\n```\nsample ^dup\n```\nreal ^dup\n\n## B\nkeep";
  const fencedBlock = "```\nsample ^dup\n```";

  it("replace touches only the real block; the fenced example survives byte-identical", async () => {
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace",
        anchor: { type: "block", block_id: "dup" },
        content: "NEW",
      });
      expect(r.ok).toBe(true);
      const out = v.read("a.md");
      expect(out).toBe("## A\n```\nsample ^dup\n```\nNEW\n\n## B\nkeep");
      expect(out).toContain(fencedBlock);
    } finally {
      v.cleanup();
    }
  });

  it("append touches only after the real block; the fenced example survives byte-identical", async () => {
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        anchor: { type: "block", block_id: "dup" },
        content: "AFTER",
      });
      expect(r.ok).toBe(true);
      const out = v.read("a.md");
      expect(out).toBe("## A\n```\nsample ^dup\n```\nreal ^dup\nAFTER\n\n## B\nkeep");
      expect(out).toContain(fencedBlock);
    } finally {
      v.cleanup();
    }
  });

  it("prepend touches only before the real block; the fenced example survives byte-identical", async () => {
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "prepend",
        anchor: { type: "block", block_id: "dup" },
        content: "BEFORE",
      });
      expect(r.ok).toBe(true);
      const out = v.read("a.md");
      expect(out).toBe("## A\n```\nsample ^dup\n```\nBEFORE\nreal ^dup\n\n## B\nkeep");
      expect(out).toContain(fencedBlock);
    } finally {
      v.cleanup();
    }
  });
});

describe("Review round 2 B2: replace_text on a block anchor preserves the ^id marker", () => {
  it("refuses to match the marker itself — old_string not found in section", async () => {
    const raw = "para one ^blk1\nkeep";
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace_text",
        anchor: { type: "block", block_id: "blk1" },
        old_string: "^blk1",
        new_string: "",
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

  it("still matches ordinary text before the marker, which survives untouched", async () => {
    const raw = "para one ^blk1\nkeep";
    const v = makeTestVault({ files: { "a.md": raw } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "replace_text",
        anchor: { type: "block", block_id: "blk1" },
        old_string: "one",
        new_string: "TWO",
      });
      expect(r.ok).toBe(true);
      expect(v.read("a.md")).toBe("para TWO ^blk1\nkeep");
    } finally {
      v.cleanup();
    }
  });
});
