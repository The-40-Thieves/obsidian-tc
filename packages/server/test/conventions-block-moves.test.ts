// Moves and copies are judged against their origin: the source note under the source folder's rules is
// the baseline, and the destination under the destination folder's rules is the write. Only a violation
// the source did not already have, keyed by (code, property, value), can block the move or copy.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerM6Tools } from "../src/tools/m6";
import { CHECKED, confirmedCall, STATUS_RULES, withVault } from "./conventions-helpers";
import { makeM6Vault } from "./m6-helpers";

const MEETING = "meetings/SCHEMA.md";
const SAME_RULES = "meetings2/SCHEMA.md";
const LOOSE = "lax/SCHEMA.md";
const rules = STATUS_RULES;
const BAD = "---\nstatus: bogus\n---\nold\n";
const GOOD = "---\ntype: meeting\nstatus: draft\n---\nbody\n";
const FILES = {
  [MEETING]: rules("block"),
  [SAME_RULES]: rules("block"),
  [LOOSE]: rules("warn"),
};

describe("move and copy destinations are judged against their source", () => {
  it("renames a non-compliant note within its folder", async () => {
    await withVault({ ...CHECKED, files: { ...FILES, "meetings/a.md": BAD } }, async (v) => {
      const r = await confirmedCall(v, "move_note", {
        vault: "test",
        from: "meetings/a.md",
        to: "meetings/b.md",
      });
      expect(r.ok ? "ok" : JSON.stringify(r.error)).toBe("ok");
      expect(readFileSync(join(v.root, "meetings/b.md"), "utf8")).toBe(BAD);
    });
  });

  it("moves a non-compliant note into a folder with the same rules", async () => {
    await withVault({ ...CHECKED, files: { ...FILES, "meetings/a.md": BAD } }, async (v) => {
      const r = await confirmedCall(v, "move_note", {
        vault: "test",
        from: "meetings/a.md",
        to: "meetings2/a.md",
      });
      expect(r.ok ? "ok" : JSON.stringify(r.error)).toBe("ok");
      expect(v.read("meetings2/a.md")).toBe(BAD);
    });
  });

  it("refuses a move into a stricter folder whose block rule the note breaks, and creates nothing", async () => {
    await withVault({ ...CHECKED, files: { ...FILES, "lax/a.md": BAD } }, async (v) => {
      const r = await confirmedCall(v, "move_note", {
        vault: "test",
        from: "lax/a.md",
        to: "meetings/a.md",
      });
      expect(r.ok ? "ok" : r.error.code).toBe("convention_blocked");
      expect(existsSync(join(v.root, "lax/a.md"))).toBe(true);
      expect(existsSync(join(v.root, "meetings/a.md"))).toBe(false);
    });
  });

  it("moves a non-compliant note out of a strict folder into a looser one", async () => {
    await withVault({ ...CHECKED, files: { ...FILES, "meetings/a.md": BAD } }, async (v) => {
      const r = await confirmedCall(v, "move_note", {
        vault: "test",
        from: "meetings/a.md",
        to: "lax/a.md",
      });
      expect(r.ok ? "ok" : JSON.stringify(r.error)).toBe("ok");
      expect(v.read("lax/a.md")).toBe(BAD);
    });
  });

  it("refuses a copy into a stricter folder and creates no destination", async () => {
    await withVault({ ...CHECKED, files: { ...FILES, "lax/src.md": BAD } }, async (v) => {
      const r = await confirmedCall(v, "copy_note", {
        vault: "test",
        from: "lax/src.md",
        to: "meetings/c.md",
      });
      expect(r.ok ? "ok" : r.error.code).toBe("convention_blocked");
      expect(existsSync(join(v.root, "lax/src.md"))).toBe(true);
      expect(existsSync(join(v.root, "meetings/c.md"))).toBe(false);
    });
  });

  it("overwrites a compliant note with a non-compliant one whose source baseline is the same", async () => {
    await withVault(
      { ...CHECKED, files: { ...FILES, "meetings/src.md": BAD, "meetings/dst.md": GOOD } },
      async (v) => {
        const r = await confirmedCall(v, "move_note", {
          vault: "test",
          from: "meetings/src.md",
          to: "meetings/dst.md",
          overwrite: true,
        });
        expect(r.ok ? "ok" : JSON.stringify(r.error)).toBe("ok");
        expect(v.read("meetings/dst.md")).toBe(BAD);
      },
    );
  });

  it("judges a move from a source the caller cannot read as new, and echoes none of its bytes", async () => {
    const secret = "---\nstatus: bogus\n---\nOLD-BODY-SECRET\n";
    await withVault(
      {
        ...CHECKED,
        acl: { readPaths: ["meetings/**", "**/SCHEMA.md"], writePaths: ["**"] },
        files: { ...FILES, "locked/a.md": secret },
      },
      async (v) => {
        const r = await confirmedCall(v, "move_note", {
          vault: "test",
          from: "locked/a.md",
          to: "meetings/a.md",
        });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error.code).toBe("convention_blocked");
        expect(JSON.stringify(r)).not.toContain("OLD-BODY-SECRET");
        expect(existsSync(join(v.root, "locked/a.md"))).toBe(true);
      },
    );
  });
});

/** A vault with the M6 bulk writers registered over the same folder rules. */
function bulkVault(files: Record<string, string>) {
  return makeM6Vault({
    conventions: true,
    files,
    register: (reg, deps) =>
      registerM6Tools(reg, {
        ...deps,
        toolSurface: () => ({ config: reg.visibilityConfig(), tools: reg.list() }),
      }),
  });
}

describe("bulk_move_notes judges each row against its source", () => {
  it("dry_run reports would_block for exactly the refused row and writes nothing", async () => {
    const v = bulkVault({ ...FILES, "lax/a.md": BAD, "lax/c.md": GOOD });
    try {
      const r = await v.callConfirmed("bulk_move_notes", {
        vault: "test",
        dry_run: true,
        moves: [
          { from: "lax/a.md", to: "meetings/a2.md" },
          { from: "lax/c.md", to: "meetings/c2.md" },
        ],
      });
      expect(r.ok ? "ok" : JSON.stringify(r.error)).toBe("ok");
      const results = r.ok
        ? (r.data as { results: { from: string; would_block?: { code: string } }[] }).results
        : [];
      expect(results.map((x) => x.would_block?.code)).toEqual(["convention_blocked", undefined]);
      expect(v.read("lax/a.md")).toBe(BAD);
      expect(existsSync(join(v.root, "meetings/a2.md"))).toBe(false);
      expect(existsSync(join(v.root, "lax/c.md"))).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  it("a real run with one refused row refuses the whole batch and moves nothing", async () => {
    const v = bulkVault({ ...FILES, "lax/a.md": BAD, "lax/c.md": GOOD });
    try {
      const r = await v.callConfirmed("bulk_move_notes", {
        vault: "test",
        dry_run: false,
        moves: [
          { from: "lax/a.md", to: "meetings/a2.md" },
          { from: "lax/c.md", to: "meetings/c2.md" },
        ],
      });
      expect(r.ok ? "ok" : r.error.code).toBe("convention_blocked");
      expect(existsSync(join(v.root, "lax/a.md"))).toBe(true);
      expect(existsSync(join(v.root, "lax/c.md"))).toBe(true);
      expect(existsSync(join(v.root, "meetings/a2.md"))).toBe(false);
      expect(existsSync(join(v.root, "meetings/c2.md"))).toBe(false);
    } finally {
      v.cleanup();
    }
  });
});

describe("the backlink rewrite of a move is not judged", () => {
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
