import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { makeTestVault } from "./m1-helpers";

const PATH = "Projects/Plan.md";
const ANCHOR = { type: "heading", heading: "Goals" } as const;
const NOTE = [
  "# Plan",
  "## Goals",
  "- draft task",
  "## ClassifiedHeading",
  "- ultra-secret-phrase",
].join("\n");

const PATCH = {
  vault: "test",
  path: PATH,
  operation: "replace_text",
  anchor: ANCHOR,
  old_string: "ultra-secret-phrase",
  new_string: "replacement",
};

function errorOf(result: ToolResult) {
  if (result.ok) throw new Error(`expected an error, got ${JSON.stringify(result.data)}`);
  return result.error;
}

function expectGenericMismatch(error: { code: string; message: string; details?: unknown }): void {
  expect(error.code).toBe("invalid_input");
  expect(error.message).toBe("old_string must occur exactly once in the section");
  expect(error.details).toEqual({ path: PATH, anchor: ANCHOR });

  const wire = JSON.stringify(error);
  expect(wire).not.toContain("ClassifiedHeading");
  expect(wire).not.toContain("draft task");
  expect(wire).not.toContain("ultra-secret-phrase");
}

describe("patch_note replace_text miss detail read authorization", () => {
  it("returns only the generic miss to a caller without read:notes", async () => {
    const v = makeTestVault({ files: { [PATH]: NOTE } });
    try {
      const result = await v.call("patch_note", PATCH, {
        grantedScopes: new Set(["write:notes"]),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expectGenericMismatch(result.error);
    } finally {
      v.cleanup();
    }
  });

  it("returns only the generic miss when readPaths excludes the note", async () => {
    const v = makeTestVault({
      files: { [PATH]: NOTE },
      acl: { readPaths: ["Public/**"] },
    });
    try {
      const result = await v.call("patch_note", PATCH, {
        grantedScopes: new Set(["read:notes", "write:notes"]),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expectGenericMismatch(result.error);
    } finally {
      v.cleanup();
    }
  });

  it("keeps the full miss detail for a caller allowed to read the note", async () => {
    const v = makeTestVault({ files: { [PATH]: NOTE } });
    try {
      const result = await v.call("patch_note", PATCH, {
        grantedScopes: new Set(["read:notes", "write:notes"]),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("invalid_input");
      expect(result.error.message).toBe("old_string not found in section");
      expect(result.error.details).toEqual({
        path: PATH,
        anchor: ANCHOR,
        section_resolved: { heading: "Goals", start_line: 2, end_line: 3 },
        found_elsewhere: { count: 1, headings: ["ClassifiedHeading"] },
        nearest: { line: 3, similarity: expect.any(Number) },
      });
    } finally {
      v.cleanup();
    }
  });

  it("keeps the exact duplicate-match refusal for a caller allowed to read the note", async () => {
    const duplicate = ["## Goals", "ultra-secret-phrase", "ultra-secret-phrase"].join("\n");
    const v = makeTestVault({ files: { [PATH]: duplicate } });
    try {
      const error = errorOf(
        await v.call("patch_note", PATCH, {
          grantedScopes: new Set(["read:notes", "write:notes"]),
        }),
      );
      expect(error.code).toBe("invalid_input");
      expect(error.message).toBe(
        "old_string matches 2 times in the section; must occur exactly once",
      );
      expect(error.details).toEqual({ path: PATH, anchor: ANCHOR, count: 2 });
    } finally {
      v.cleanup();
    }
  });
});

describe("patch_note replace_text mismatch count disclosure", () => {
  const zeroAnchored = ["## Goals", "safe"].join("\n");
  const duplicateAnchored = ["## Goals", "ultra-secret-phrase", "ultra-secret-phrase"].join("\n");
  const zeroWholeNote = "safe";
  const duplicateWholeNote = ["ultra-secret-phrase", "ultra-secret-phrase"].join("\n");

  for (const auth of [
    {
      label: "without read:notes",
      options: {},
      scopes: new Set(["write:notes"]),
    },
    {
      label: "when read ACL denies the note",
      options: { acl: { readPaths: ["Public/**"] as string[] } },
      scopes: new Set(["read:notes", "write:notes"]),
    },
  ] as const) {
    for (const scope of [
      {
        label: "anchored",
        patch: PATCH,
        notes: [zeroAnchored, duplicateAnchored],
        details: { path: PATH, anchor: ANCHOR },
      },
      {
        label: "note-wide",
        patch: { ...PATCH, anchor: undefined },
        notes: [zeroWholeNote, duplicateWholeNote],
        details: { path: PATH },
      },
    ] as const) {
      it(`makes zero and duplicate ${scope.label} matches indistinguishable ${auth.label}`, async () => {
        const errors = [];
        for (const note of scope.notes) {
          const v = makeTestVault({ files: { [PATH]: note }, ...auth.options });
          try {
            const error = errorOf(
              await v.call("patch_note", scope.patch, { grantedScopes: auth.scopes }),
            );
            expect(error.code).toBe("invalid_input");
            expect(error.message).toBe("old_string must occur exactly once in the section");
            expect(error.details).toEqual(scope.details);
            expect(JSON.stringify(error)).not.toContain("count");
            errors.push(error);
          } finally {
            v.cleanup();
          }
        }
        expect(errors).toHaveLength(2);
        expect(errors[0]).toEqual(errors[1]);
      });
    }
  }

  // A successful write still reveals that a unique match existed. That is inherent in performing
  // the requested mutation and is outside this refusal-only disclosure fix.
  it("still permits a unique match for a write-only caller", async () => {
    const v = makeTestVault({
      files: { [PATH]: ["## Goals", "ultra-secret-phrase"].join("\n") },
    });
    try {
      const result = await v.call("patch_note", PATCH, {
        grantedScopes: new Set(["write:notes"]),
      });
      expect(result.ok).toBe(true);
    } finally {
      v.cleanup();
    }
  });
});

describe("patch_note anchor-resolution disclosure", () => {
  const headingPatch = {
    vault: "test",
    path: PATH,
    operation: "replace_text",
    anchor: ANCHOR,
    old_string: "old",
    new_string: "new",
  } as const;
  const duplicateHeadings = ["## Goals", "old", "## Goals", "old"].join("\n");

  for (const auth of [
    {
      label: "without read:notes",
      options: {},
      scopes: new Set(["write:notes"]),
    },
    {
      label: "when read ACL denies the note",
      options: { acl: { readPaths: ["Public/**"] as string[] } },
      scopes: new Set(["read:notes", "write:notes"]),
    },
  ] as const) {
    it(`collapses missing, ambiguous, and out-of-range headings ${auth.label}`, async () => {
      const cases = [
        { note: "## Other\nold", patch: headingPatch },
        { note: duplicateHeadings, patch: headingPatch },
        {
          note: duplicateHeadings,
          patch: { ...headingPatch, anchor: { ...ANCHOR, occurrence: 3 } },
        },
      ];
      const errors = [];
      for (const testCase of cases) {
        const v = makeTestVault({ files: { [PATH]: testCase.note }, ...auth.options });
        try {
          const error = errorOf(
            await v.call("patch_note", testCase.patch, { grantedScopes: auth.scopes }),
          );
          expect(error).toMatchObject({
            code: "invalid_input",
            message: "anchor could not be resolved",
            details: { path: PATH },
          });
          errors.push(error);
        } finally {
          v.cleanup();
        }
      }
      expect(errors[0]).toEqual(errors[1]);
      expect(errors[1]).toEqual(errors[2]);
    });

    it(`collapses missing and ambiguous block anchors ${auth.label}`, async () => {
      const blockPatch = {
        vault: "test",
        path: PATH,
        operation: "append",
        anchor: { type: "block", block_id: "secret-block" },
        content: "new",
      } as const;
      const errors = [];
      for (const note of ["plain text", "first ^secret-block\n\nsecond ^secret-block"]) {
        const v = makeTestVault({ files: { [PATH]: note }, ...auth.options });
        try {
          const error = errorOf(
            await v.call("patch_note", blockPatch, { grantedScopes: auth.scopes }),
          );
          expect(error).toMatchObject({
            code: "invalid_input",
            message: "anchor could not be resolved",
            details: { path: PATH },
          });
          errors.push(error);
        } finally {
          v.cleanup();
        }
      }
      expect(errors[0]).toEqual(errors[1]);
    });
  }

  it("keeps exact heading resolution errors for a reader", async () => {
    const cases = [
      {
        note: "## Other\nold",
        patch: headingPatch,
        message: "target heading not found",
        details: { path: PATH, anchor: ANCHOR },
      },
      {
        note: duplicateHeadings,
        patch: headingPatch,
        message:
          'ambiguous heading: matches 2 lines (1, 3); add occurrence (1-based, in document order) to the anchor, e.g. {type:"heading",heading:"Notes",occurrence:2}, or name the parent: heading:"Parent > Notes"',
        details: { path: PATH, anchor: ANCHOR, count: 2, lines: [1, 3] },
      },
      {
        note: duplicateHeadings,
        patch: { ...headingPatch, anchor: { ...ANCHOR, occurrence: 3 } },
        message: "heading occurrence 3 is out of range: the heading matches 2 lines (1, 3)",
        details: {
          path: PATH,
          anchor: { ...ANCHOR, occurrence: 3 },
          count: 2,
          lines: [1, 3],
          occurrence: 3,
        },
      },
    ];
    for (const testCase of cases) {
      const v = makeTestVault({ files: { [PATH]: testCase.note } });
      try {
        const error = errorOf(
          await v.call("patch_note", testCase.patch, {
            grantedScopes: new Set(["read:notes", "write:notes"]),
          }),
        );
        expect(error.code).toBe("invalid_input");
        expect(error.message).toBe(testCase.message);
        expect(error.details).toEqual(testCase.details);
      } finally {
        v.cleanup();
      }
    }
  });

  it("keeps exact block resolution errors for a reader", async () => {
    const blockPatch = {
      vault: "test",
      path: PATH,
      operation: "append",
      anchor: { type: "block", block_id: "secret-block" },
      content: "new",
    } as const;
    const cases = [
      {
        note: "plain text",
        message: "block reference not found",
        details: { path: PATH, anchor: blockPatch.anchor },
      },
      {
        note: "first ^secret-block\n\nsecond ^secret-block",
        message: "ambiguous block reference: matches 2 lines (1, 3)",
        details: { block_id: "secret-block", count: 2, lines: [1, 3] },
      },
    ];
    for (const testCase of cases) {
      const v = makeTestVault({ files: { [PATH]: testCase.note } });
      try {
        const error = errorOf(
          await v.call("patch_note", blockPatch, {
            grantedScopes: new Set(["read:notes", "write:notes"]),
          }),
        );
        expect(error.code).toBe("invalid_input");
        expect(error.message).toBe(testCase.message);
        expect(error.details).toEqual(testCase.details);
      } finally {
        v.cleanup();
      }
    }
  });
});

describe("patch_note large-replace line-count disclosure", () => {
  const replace = {
    vault: "test",
    path: PATH,
    operation: "replace",
    anchor: ANCHOR,
    content: "replacement",
  } as const;
  const largeNote = (bodyLines: number): string =>
    ["## Goals", ...Array.from({ length: bodyLines }, (_, i) => `secret-${i}`)].join("\n");

  for (const auth of [
    {
      label: "without read:notes",
      options: {},
      scopes: new Set(["write:notes"]),
    },
    {
      label: "when read ACL denies the note",
      options: { acl: { readPaths: ["Public/**"] as string[] } },
      scopes: new Set(["read:notes", "write:notes"]),
    },
  ] as const) {
    it(`hides exact removed and body line counts ${auth.label}`, async () => {
      const errors = [];
      for (const bodyLines of [21, 30]) {
        const v = makeTestVault({ files: { [PATH]: largeNote(bodyLines) }, ...auth.options });
        try {
          const error = errorOf(
            await v.call("patch_note", replace, { grantedScopes: auth.scopes }),
          );
          expect(error.code).toBe("invalid_input");
          expect(error.message).toBe(
            "replace requires confirm_replace: true to proceed, or a narrower anchor",
          );
          expect(error.details).toEqual({ path: PATH, anchor: ANCHOR });
          const wire = JSON.stringify(error);
          expect(wire).not.toContain("lines_removed");
          expect(wire).not.toContain("body_line_count");
          errors.push(error);
        } finally {
          v.cleanup();
        }
      }
      expect(errors[0]).toEqual(errors[1]);
    });
  }

  it("keeps the exact line-count refusal for a caller allowed to read the note", async () => {
    const v = makeTestVault({ files: { [PATH]: largeNote(21) } });
    try {
      const error = errorOf(
        await v.call("patch_note", replace, {
          grantedScopes: new Set(["read:notes", "write:notes"]),
        }),
      );
      expect(error.code).toBe("invalid_input");
      expect(error.message).toBe(
        'replace would remove 21 of 22 lines in the note body (heading "Goals" has no lower-or-equal heading below it to bound the section). Set confirm_replace: true to proceed, or narrow the anchor to a subsection.',
      );
      expect(error.details).toEqual({
        path: PATH,
        anchor: ANCHOR,
        lines_removed: 21,
        body_line_count: 22,
      });
    } finally {
      v.cleanup();
    }
  });
});
