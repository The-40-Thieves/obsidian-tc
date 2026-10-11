// patch_note replace_text without an anchor: the scope is the whole note body (frontmatter
// excluded and preserved, heading lines included), with the same exactly-one-match safety as an
// anchored replace. Anchored replace_text and the anchor requirement of every other operation are
// covered by patch-note-anchors and patch-note-discoverability.
import { describe, expect, it } from "vitest";
import { buildFullRegistry } from "../scripts/docgen/build-registry";
import { describeCapability } from "../src/mcp/facade";
import { PatchInput } from "../src/tools/m1/notes/schemas";
import { makeTestVault } from "./m1-helpers";

const PATH = "Projects/Plan.md";
const NOTE = [
  "---",
  "title: Plan",
  "status: draft",
  "---",
  "# Plannig",
  "## Goals",
  "- ship it",
  "- ship it again",
  "",
].join("\n");

describe("replace_text with no anchor: whole-note scope", () => {
  it("replaces a unique match anywhere in the body and leaves the frontmatter alone", async () => {
    const v = makeTestVault({ files: { [PATH]: NOTE } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: PATH,
        operation: "replace_text",
        old_string: "- ship it again",
        new_string: "- shipped",
      });
      expect(r.ok).toBe(true);
      expect(v.read(PATH)).toBe(NOTE.replace("- ship it again", "- shipped"));
    } finally {
      v.cleanup();
    }
  });

  it("matches inside a heading line, so a heading typo can be fixed", async () => {
    const v = makeTestVault({ files: { [PATH]: NOTE } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: PATH,
        operation: "replace_text",
        old_string: "Plannig",
        new_string: "Planning",
      });
      expect(r.ok).toBe(true);
      expect(v.read(PATH)).toBe(NOTE.replace("# Plannig", "# Planning"));
    } finally {
      v.cleanup();
    }
  });

  it("refuses 0 matches with the existing message and changes nothing", async () => {
    const v = makeTestVault({ files: { [PATH]: NOTE } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: PATH,
        operation: "replace_text",
        old_string: "ghost",
        new_string: "x",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("invalid_input");
        expect(r.error.message).toBe("old_string not found in section");
      }
      expect(v.read(PATH)).toBe(NOTE);
    } finally {
      v.cleanup();
    }
  });

  it("refuses 2+ matches and names the count, changing nothing", async () => {
    const v = makeTestVault({ files: { [PATH]: NOTE } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: PATH,
        operation: "replace_text",
        old_string: "ship it",
        new_string: "x",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("invalid_input");
        expect(r.error.message).toBe(
          "old_string matches 2 times in the section; must occur exactly once",
        );
        expect(r.error.details).toMatchObject({ count: 2 });
      }
      expect(v.read(PATH)).toBe(NOTE);
    } finally {
      v.cleanup();
    }
  });

  it("an old_string that occurs only in the frontmatter is refused as 0 matches and the frontmatter is unchanged", async () => {
    const v = makeTestVault({ files: { [PATH]: NOTE } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: PATH,
        operation: "replace_text",
        old_string: "draft",
        new_string: "final",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toBe("old_string not found in section");
      expect(v.read(PATH)).toBe(NOTE);
    } finally {
      v.cleanup();
    }
  });

  it("an anchored replace_text still never matches the anchor's own heading line", async () => {
    const v = makeTestVault({ files: { [PATH]: NOTE } });
    try {
      const r = await v.call("patch_note", {
        vault: "test",
        path: PATH,
        operation: "replace_text",
        target_heading: "Goals",
        old_string: "## Goals",
        new_string: "## Aims",
      });
      expect(r.ok).toBe(false);
      expect(v.read(PATH)).toBe(NOTE);
    } finally {
      v.cleanup();
    }
  });

  it("the schema accepts replace_text with neither anchor nor target_heading", () => {
    const r = PatchInput.safeParse({
      vault: "test",
      path: PATH,
      operation: "replace_text",
      old_string: "a",
      new_string: "b",
    });
    expect(r.success).toBe(true);
  });

  it("append with no anchor is still refused with the #1233 message", () => {
    const r = PatchInput.safeParse({
      vault: "test",
      path: PATH,
      operation: "append",
      content: "x",
    });
    expect(r.success).toBe(false);
    const messages = r.success ? "" : r.error.issues.map((i) => i.message).join("\n");
    expect(messages).toContain('operation "append" requires anchor or target_heading');
  });

  for (const name of ["patch_note", "patch_active_file"]) {
    it(`${name}'s published description says replace_text is note-wide without an anchor`, () => {
      const def = buildFullRegistry()
        .list()
        .find((d) => d.name === name);
      if (!def) throw new Error(`${name} is not registered`);
      expect(describeCapability(def).description).toContain("note-wide");
    });
  }
});
