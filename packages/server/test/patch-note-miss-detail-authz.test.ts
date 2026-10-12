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

function expectGenericMiss(error: { code: string; message: string; details?: unknown }): void {
  expect(error.code).toBe("invalid_input");
  expect(error.message).toBe("old_string not found in section");
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
      if (!result.ok) expectGenericMiss(result.error);
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
      if (!result.ok) expectGenericMiss(result.error);
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
});
