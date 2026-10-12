// patch_note replace_text miss detail (#1226): a 0-match refusal says where the string is instead of
// only "old_string not found in section". The message and the invalid_input code are unchanged; the
// detail rides in error.details, and never carries note text.
import { describe, expect, it } from "vitest";
import { makeTestVault } from "./m1-helpers";

const PATH = "Projects/Plan.md";
const NOTE = ["# Plan", "## Goals", "- ship   it", "- keep going", "## Other", "- zebra line"].join(
  "\n",
);

describe("replace_text 0-match refusal: error.details says where the string is", () => {
  const miss = async (args: Record<string, unknown>) => {
    const v = makeTestVault({ files: { [PATH]: NOTE } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: PATH,
        operation: "replace_text",
        new_string: "x",
        ...args,
      });
      expect(r.ok).toBe(false);
      expect(v.read(PATH)).toBe(NOTE);
      return r.ok ? undefined : r.error;
    } finally {
      v.cleanup();
    }
  };
  const goals = { anchor: { type: "heading", heading: "Goals" } };

  it("string present only under another heading: found_elsewhere names that heading", async () => {
    const e = await miss({ ...goals, old_string: "zebra line" });
    expect(e?.code).toBe("invalid_input");
    expect(e?.message).toBe("old_string not found in section");
    expect(e?.details).toMatchObject({
      section_resolved: { heading: "Goals", start_line: 2, end_line: 4 },
      found_elsewhere: { count: 1, headings: ["Other"] },
    });
  });

  it("whitespace and case differ: nearest is the line with similarity 1", async () => {
    const e = await miss({ ...goals, old_string: "- SHIP it" });
    expect(e?.message).toBe("old_string not found in section");
    expect(e?.details).toMatchObject({
      nearest: { line: 3, similarity: 1 },
      found_elsewhere: { count: 0, headings: [] },
    });
  });

  it("multi-line old_string that differs only in whitespace across lines: similarity 1", async () => {
    const e = await miss({ ...goals, old_string: "- ship it\n- keep going" });
    expect(e?.details).toMatchObject({ nearest: { line: 3, similarity: 1 } });
  });

  it("string absent everywhere: nearest is present with similarity below 1, nothing elsewhere", async () => {
    const e = await miss({ ...goals, old_string: "- ship it!" });
    const d = e?.details as { nearest: { line: number; similarity: number } };
    expect(d.nearest.line).toBe(3);
    expect(d.nearest.similarity).toBeGreaterThan(0.5);
    expect(d.nearest.similarity).toBeLessThan(1);
    expect(e?.details).toMatchObject({ found_elsewhere: { count: 0, headings: [] } });
  });

  it("whole-note scope: section_resolved has a null heading and found_elsewhere is omitted", async () => {
    const e = await miss({ old_string: "ghost" });
    expect(e?.details).toMatchObject({
      section_resolved: { heading: null, start_line: 1, end_line: 6 },
    });
    expect(e?.details).not.toHaveProperty("found_elsewhere");
  });

  it("the details never echo note text", async () => {
    const e = await miss({ ...goals, old_string: "nowhere-token" });
    const wire = JSON.stringify(e?.details);
    expect(wire).not.toContain("ship   it");
    expect(wire).not.toContain("keep going");
    expect(wire).not.toContain("zebra line");
  });
});
