// Moves and copies are warn-only in this slice: no origin is recorded, so a destination is judged as a new
// note and a rename of an already non-compliant note would be refused. PR 4 adds origin-aware judging.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerM6Tools } from "../src/tools/m6";
import { CHECKED, confirmedCall, STATUS_RULES, withVault } from "./conventions-helpers";
import { makeM6Vault } from "./m6-helpers";

const MEETING = "meetings/SCHEMA.md";
const rules = STATUS_RULES;
const BAD = "---\nstatus: bogus\n---\nold\n";
const GOOD = "---\ntype: meeting\nstatus: draft\n---\nbody\n";

describe("move and copy destinations are warn-only", () => {
  it("renames a non-compliant note within its folder", async () => {
    await withVault(
      { ...CHECKED, files: { [MEETING]: rules("block"), "meetings/a.md": BAD } },
      async (v) => {
        const r = await confirmedCall(v, "move_note", {
          vault: "test",
          from: "meetings/a.md",
          to: "meetings/b.md",
        });
        expect(r.ok ? "ok" : JSON.stringify(r.error)).toBe("ok");
        expect(readFileSync(join(v.root, "meetings/b.md"), "utf8")).toBe(BAD);
      },
    );
  });

  it("a bulk move with a non-compliant row moves every row", async () => {
    const v = makeM6Vault({
      conventions: true,
      files: { [MEETING]: rules("block"), "meetings/a.md": BAD, "meetings/c.md": GOOD },
      register: (reg, deps) =>
        registerM6Tools(reg, {
          ...deps,
          toolSurface: () => ({ config: reg.visibilityConfig(), tools: reg.list() }),
        }),
    });
    try {
      const r = await v.callConfirmed("bulk_move_notes", {
        vault: "test",
        dry_run: false,
        moves: [
          { from: "meetings/a.md", to: "meetings/a2.md" },
          { from: "meetings/c.md", to: "meetings/c2.md" },
        ],
      });
      expect(r.ok ? "ok" : JSON.stringify(r.error)).toBe("ok");
      expect(v.read("meetings/a2.md")).toBe(BAD);
      expect(v.read("meetings/c2.md")).toBe(GOOD);
    } finally {
      v.cleanup();
    }
  });

  it("a copy over a compliant note with non-compliant content is not blocked and warns", async () => {
    await withVault(
      {
        ...CHECKED,
        files: { [MEETING]: rules("block"), "meetings/src.md": BAD, "meetings/dst.md": GOOD },
      },
      async (v) => {
        const r = await confirmedCall(v, "copy_note", {
          vault: "test",
          from: "meetings/src.md",
          to: "meetings/dst.md",
          overwrite: true,
        });
        expect(r.ok ? "ok" : JSON.stringify(r.error)).toBe("ok");
        expect(v.read("meetings/dst.md")).toBe(BAD);
        const warnings = r.ok
          ? (r.data as { conventions?: { warnings?: unknown[] } }).conventions?.warnings
          : undefined;
        expect(warnings?.length ?? 0).toBeGreaterThan(0);
      },
    );
  });
});

describe("the backlink rewrite of a move is warn-only", () => {
  it("renames a note whose frontmatter link to it is rewritten in a non-compliant note, unblocked", async () => {
    // The rewrite changes a frontmatter value, so a block rule on `related` would refuse it without the exemption.
    const linker = '---\nstatus: bogus\nrelated: "[[meetings/target]]"\n---\nbody\n';
    await withVault(
      {
        ...CHECKED,
        files: {
          [MEETING]: rules("block")
            .replace(
              "values: { status: [draft, current] }",
              'values: { status: [draft, current], related: ["[[meetings/target]]"] }',
            )
            .replace(
              "severity: { type: block, status: block }",
              "severity: { type: block, status: block, related: block }",
            ),
          "meetings/target.md": GOOD,
          "meetings/linker.md": linker,
        },
      },
      async (v) => {
        const r = await confirmedCall(v, "move_note", {
          vault: "test",
          from: "meetings/target.md",
          to: "meetings/renamed.md",
        });
        expect(r.ok ? "ok" : JSON.stringify(r.error)).toBe("ok");
        expect(v.read("meetings/linker.md")).toContain("renamed");
      },
    );
  });
});
