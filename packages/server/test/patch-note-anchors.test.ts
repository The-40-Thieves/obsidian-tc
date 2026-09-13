// THE-1038: patch_note anchor correctness (GH #922, #926) — every repro string quoted in those
// issues becomes a test case here, at the tool level (through patch_note/read_note), rather than
// unit tests on notes/anchors.ts's internals directly, so a regression is caught exactly where a
// caller would see it.
import { describe, expect, it } from "vitest";
import { makeTestVault } from "./m1-helpers";

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
