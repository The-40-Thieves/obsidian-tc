import { describe, expect, it } from "vitest";
import { patchByHeading } from "../src/tools/m1/notes/anchors";
import { PatchInput } from "../src/tools/m1/notes/schemas";
import { makeTestVault } from "./m1-helpers";

const basePatch = {
  vault: "test",
  path: "a.md",
  operation: "append",
  anchor: { type: "heading", heading: "Notes" },
  content: "new content",
  insert_before: "Parent: [[Index]]",
} as const;

describe("GH #1228: patch_note append insert_before", () => {
  it("inserts above a footer line in the last heading section", async () => {
    const before = [
      "# Project",
      "## Notes",
      "existing content",
      "—",
      "Signed, X",
      "Parent: [[Index]]",
    ].join("\n");
    const v = makeTestVault({ files: { "a.md": before } });
    try {
      const result = await v.call("patch_note", basePatch);
      expect(result.ok).toBe(true);
      expect(v.read("a.md")).toBe(
        [
          "# Project",
          "## Notes",
          "existing content",
          "—",
          "Signed, X",
          "new content",
          "Parent: [[Index]]",
        ].join("\n"),
      );
    } finally {
      v.cleanup();
    }
  });

  it("preserves CRLF throughout the note", async () => {
    const before = ["# Project", "## Notes", "body", "Parent: [[Index]]", ""].join("\r\n");
    const v = makeTestVault({ files: { "a.md": before } });
    try {
      const result = await v.call("patch_note", basePatch);
      expect(result.ok).toBe(true);
      expect(v.read("a.md")).toBe(
        ["# Project", "## Notes", "body", "new content", "Parent: [[Index]]", ""].join("\r\n"),
      );
    } finally {
      v.cleanup();
    }
  });

  it("does not match a target line inside a fenced code block", async () => {
    const before = ["## Notes", "```md", "Parent: [[Index]]", "```", "ordinary body"].join("\n");
    const v = makeTestVault({ files: { "a.md": before } });
    try {
      const result = await v.call("patch_note", basePatch);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toBe("insert_before not found in section");
      expect(v.read("a.md")).toBe(before);
    } finally {
      v.cleanup();
    }
  });

  it("refuses two matches in the target section and reports count 2", async () => {
    const before = ["## Notes", "Parent: [[Index]]", "body", "Parent: [[Index]]   "].join("\n");
    const v = makeTestVault({ files: { "a.md": before } });
    try {
      const result = await v.call("patch_note", basePatch);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe(
          "insert_before matches 2 times in the section; must occur exactly once",
        );
        expect(result.error.details).toMatchObject({ count: 2 });
      }
      expect(v.read("a.md")).toBe(before);
    } finally {
      v.cleanup();
    }
  });

  it("scopes uniqueness to the resolved section", async () => {
    const before = ["## Other", "Parent: [[Index]]", "## Notes", "body", "Parent: [[Index]]"].join(
      "\n",
    );
    const v = makeTestVault({ files: { "a.md": before } });
    try {
      const result = await v.call("patch_note", basePatch);
      expect(result.ok).toBe(true);
      expect(v.read("a.md")).toBe(
        [
          "## Other",
          "Parent: [[Index]]",
          "## Notes",
          "body",
          "new content",
          "Parent: [[Index]]",
        ].join("\n"),
      );
    } finally {
      v.cleanup();
    }
  });

  it("does not match the anchor heading line itself", async () => {
    const before = "## Notes\nbody";
    const v = makeTestVault({ files: { "a.md": before } });
    try {
      const result = await v.call("patch_note", {
        ...basePatch,
        insert_before: "## Notes",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toBe("insert_before not found in section");
      expect(v.read("a.md")).toBe(before);
    } finally {
      v.cleanup();
    }
  });

  it.each(["", " ", "\t", " \t\r\n"])("refuses an empty insert_before value %#", (insertBefore) => {
    const parsed = PatchInput.safeParse({
      ...basePatch,
      insert_before: insertBefore,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(parsed.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["insert_before"],
          message: "insert_before must contain non-whitespace content",
        }),
      );
  });

  it.each([
    { body: "## Notes\nbody\n", count: 0, matchLines: [] },
    { body: "## Notes\nbody\n\n", count: 1, matchLines: [3] },
  ])("does not count the trailing split phantom as a real blank line: $body", (testCase) => {
    const result = patchByHeading(
      testCase.body,
      "append",
      "Notes",
      "new content",
      "\n",
      undefined,
      " ",
    );
    expect(result?.insertBefore).toMatchObject({
      count: testCase.count,
      matchLines: testCase.matchLines,
    });
  });

  it.each(["prepend", "replace", "replace_text"] as const)(
    "refuses insert_before with operation %s",
    (operation) => {
      const input =
        operation === "replace_text"
          ? {
              vault: "test",
              path: "a.md",
              operation,
              old_string: "old",
              new_string: "new",
              insert_before: "footer",
            }
          : {
              vault: "test",
              path: "a.md",
              operation,
              target_heading: "Notes",
              content: "new",
              insert_before: "footer",
            };
      const parsed = PatchInput.safeParse(input);
      expect(parsed.success).toBe(false);
      if (!parsed.success)
        expect(parsed.error.issues).toContainEqual(
          expect.objectContaining({
            path: ["insert_before"],
            message: `operation "${operation}" forbids insert_before; it is only valid for append`,
          }),
        );
    },
  );

  it("keeps ordinary append output byte-identical when insert_before is omitted", async () => {
    const before = "## Notes\nbody\n## Next\nkeep\n";
    const v = makeTestVault({ files: { "a.md": before } });
    try {
      const result = await v.call("patch_note", {
        vault: "test",
        path: "a.md",
        operation: "append",
        target_heading: "Notes",
        content: "new content",
      });
      expect(result.ok).toBe(true);
      expect(v.read("a.md")).toBe("## Notes\nbody\nnew content\n## Next\nkeep\n");
    } finally {
      v.cleanup();
    }
  });
});

describe("patch_note insert_before miss detail read authorization", () => {
  const note = [
    "# Plan",
    "## Notes",
    "Parent: [[Actual]]",
    "## ClassifiedHeading",
    "Parent: [[Index]]",
  ].join("\n");

  it("makes zero and duplicate matches indistinguishable without read:notes", async () => {
    const errors: unknown[] = [];
    for (const before of [
      note,
      ["## Notes", "Parent: [[Index]]", "body", "Parent: [[Index]]"].join("\n"),
    ]) {
      const v = makeTestVault({ files: { "a.md": before } });
      try {
        const result = await v.call("patch_note", basePatch, {
          grantedScopes: new Set(["write:notes"]),
        });
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.error.message).toBe(
          "insert_before must match exactly one line in the section",
        );
        expect(result.error.details).toEqual({
          path: "a.md",
          anchor: { type: "heading", heading: "Notes" },
        });
        const wire = JSON.stringify(result.error);
        for (const secret of [
          "count",
          "match_lines",
          "found_elsewhere",
          "nearest",
          "ClassifiedHeading",
          "Actual",
        ])
          expect(wire).not.toContain(secret);
        errors.push(result.error);
      } finally {
        v.cleanup();
      }
    }
    expect(errors).toHaveLength(2);
    expect(errors[0]).toEqual(errors[1]);
  });

  it("returns only the generic miss when readPaths excludes the note", async () => {
    const v = makeTestVault({
      files: { "a.md": note },
      acl: { readPaths: ["Public/**"] },
    });
    try {
      const result = await v.call("patch_note", basePatch, {
        grantedScopes: new Set(["read:notes", "write:notes"]),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toBe("insert_before must match exactly one line in the section");
      expect(result.error.details).toEqual({
        path: "a.md",
        anchor: { type: "heading", heading: "Notes" },
      });
      expect(JSON.stringify(result.error)).not.toContain("start_line");
    } finally {
      v.cleanup();
    }
  });

  it("returns miss detail to a caller allowed to read the note", async () => {
    const v = makeTestVault({ files: { "a.md": note } });
    try {
      const result = await v.call("patch_note", basePatch, {
        grantedScopes: new Set(["read:notes", "write:notes"]),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toBe("insert_before not found in section");
      expect(result.error.details).toMatchObject({
        section_resolved: { heading: "Notes", start_line: 2, end_line: 3 },
        found_elsewhere: { count: 1, lines: [5] },
        nearest: { line: 3, similarity: expect.any(Number) },
      });
    } finally {
      v.cleanup();
    }
  });

  it("does not report the trailing split phantom as the nearest real line", async () => {
    const before = "## Notes\n";
    const v = makeTestVault({ files: { "a.md": before } });
    try {
      const result = await v.call("patch_note", basePatch, {
        grantedScopes: new Set(["read:notes", "write:notes"]),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toBe("insert_before not found in section");
      expect(result.error.details).toMatchObject({
        section_resolved: { heading: "Notes", start_line: 1, end_line: 1 },
      });
      expect(result.error.details).not.toHaveProperty("nearest");
    } finally {
      v.cleanup();
    }
  });

  it("reports an eligible nested heading match in another section", async () => {
    const before = ["## Other", "### Parent: [[Index]]", "## Notes", "nope"].join("\n");
    const v = makeTestVault({ files: { "a.md": before } });
    try {
      const result = await v.call(
        "patch_note",
        { ...basePatch, insert_before: "### Parent: [[Index]]" },
        { grantedScopes: new Set(["read:notes", "write:notes"]) },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toBe("insert_before not found in section");
      expect(result.error.details).toMatchObject({
        found_elsewhere: { count: 1, lines: [2] },
      });
    } finally {
      v.cleanup();
    }
  });

  it("returns duplicate-match count and line numbers to a caller allowed to read the note", async () => {
    const duplicate = ["## Notes", "Parent: [[Index]]", "body", "Parent: [[Index]]"].join("\n");
    const v = makeTestVault({ files: { "a.md": duplicate } });
    try {
      const result = await v.call("patch_note", basePatch, {
        grantedScopes: new Set(["read:notes", "write:notes"]),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toBe(
        "insert_before matches 2 times in the section; must occur exactly once",
      );
      expect(result.error.details).toMatchObject({ count: 2, match_lines: [2, 4] });
    } finally {
      v.cleanup();
    }
  });
});
