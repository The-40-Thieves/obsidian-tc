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
// A note the caller cannot read: its frontmatter and body must never reach a response.
const LOCKED = "---\nstatus: zzTOPSECRETVALUE\ntype: zzLABEL\n---\nOLD-BODY-SECRET\n";
const SECRET_MARKERS = ["zzTOPSECRETVALUE", "zzLABEL", "OLD-BODY-SECRET"];
// A caller with the write and delete scopes of a move, but no read:notes.
const NO_READ = { grantedScopes: new Set(["write:notes", "delete:notes"]) };
// A readable note over the 1 MiB read bound, with the same non-compliant frontmatter as BAD.
const OVER_BOUND = `---\nstatus: bogus\n---\n${"x".repeat(1024 * 1024)}`;

function expectNoSecret(r: unknown): void {
  const echoed = JSON.stringify(r);
  for (const s of SECRET_MARKERS) expect(echoed).not.toContain(s);
}

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

  it.each(["move_note", "copy_note"] as const)(
    "%s of a non-compliant note into a folder with the same rules is not blocked",
    async (tool) => {
      await withVault({ ...CHECKED, files: { ...FILES, "meetings/a.md": BAD } }, async (v) => {
        const r = await confirmedCall(v, tool, {
          vault: "test",
          from: "meetings/a.md",
          to: "meetings2/a.md",
        });
        expect(r.ok ? "ok" : JSON.stringify(r.error)).toBe("ok");
        expect(v.read("meetings2/a.md")).toBe(BAD);
      });
    },
  );

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

  it("refuses a move from a source the caller cannot read, and echoes none of its frontmatter", async () => {
    await withVault(
      {
        ...CHECKED,
        acl: { readPaths: ["**/SCHEMA.md"], writePaths: ["**"] },
        files: { ...FILES, "locked/a.md": LOCKED },
      },
      async (v) => {
        const r = await confirmedCall(v, "move_note", {
          vault: "test",
          from: "locked/a.md",
          to: "meetings/a.md",
        });
        expect(r.ok).toBe(false);
        expectNoSecret(r);
        expect(existsSync(join(v.root, "locked/a.md"))).toBe(true);
        expect(existsSync(join(v.root, "meetings/a.md"))).toBe(false);
      },
    );
  });

  it("refuses a scope-only caller (no read:notes) moving a note it cannot read, and echoes none of it", async () => {
    await withVault({ ...CHECKED, files: { ...FILES, "locked/a.md": LOCKED } }, async (v) => {
      const r = await confirmedCall(
        v,
        "move_note",
        { vault: "test", from: "locked/a.md", to: "meetings/a.md" },
        NO_READ,
      );
      expect(r).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expectNoSecret(r);
      expect(existsSync(join(v.root, "locked/a.md"))).toBe(true);
    });
  });

  it("gives the same outcome for an unreadable source whichever one-value rule the destination holds", async () => {
    // oneA allows the source's exact secret value and oneB allows neither value, so an outcome that
    // differed between the two would show the secret was compared.
    const oneValue = (value: string): string =>
      `---\nconventions:\n  frontmatter:\n    values: { status: [${value}] }\n    severity: { status: block }\n---\n# rules\n`;
    const files = {
      "oneA/SCHEMA.md": oneValue("zzTOPSECRETVALUE"),
      "oneB/SCHEMA.md": oneValue("current"),
      "locked/a.md": LOCKED,
    };
    const outcome = (to: string): Promise<string> =>
      withVault({ ...CHECKED, files }, async (v) => {
        const r = await confirmedCall(
          v,
          "move_note",
          { vault: "test", from: "locked/a.md", to },
          NO_READ,
        );
        return r.ok ? "ok" : r.error.code;
      });
    const bulkOutcome = async (to: string, dryRun: boolean): Promise<string> => {
      const v = bulkVault(files, { readPaths: ["**/SCHEMA.md"], writePaths: ["**"] });
      try {
        const r = await v.callConfirmed("bulk_move_notes", {
          vault: "test",
          dry_run: dryRun,
          moves: [{ from: "locked/a.md", to }],
        });
        expectNoSecret(r);
        if (!r.ok) return r.error.code;
        const results = (
          r.data as { results: { would_block?: { code: string }; error?: { code: string } }[] }
        ).results;
        return results[0]?.would_block?.code ?? results[0]?.error?.code ?? "ok";
      } finally {
        v.cleanup();
      }
    };
    // The source is unreadable to this caller. A move_note caller without read:notes is refused by the
    // read:notes scope gate, and a bulk caller is refused by the read ACL, both before the conventions
    // judge reads the destination's rule.
    const into = await outcome("oneA/a.md");
    expect(into).toBe("forbidden");
    expect(await outcome("oneB/a.md")).toBe(into);
    for (const dryRun of [true, false]) {
      const bulkInto = await bulkOutcome("oneA/a.md", dryRun);
      expect(bulkInto).toBe("acl_denied");
      expect(await bulkOutcome("oneB/a.md", dryRun)).toBe(bulkInto);
    }
  });

  it("renames a note over 1 MiB whose frontmatter is non-compliant, unblocked", async () => {
    await withVault(
      { ...CHECKED, files: { ...FILES, "meetings/big.md": OVER_BOUND } },
      async (v) => {
        const r = await confirmedCall(v, "move_note", {
          vault: "test",
          from: "meetings/big.md",
          to: "meetings/big2.md",
        });
        expect(r.ok ? "ok" : JSON.stringify(r.error)).toBe("ok");
        expect(v.read("meetings/big2.md")).toBe(OVER_BOUND);
      },
    );
  });

  it.each(["move_note", "copy_note"] as const)(
    "%s of a readable note over 1 MiB into a stricter folder is refused, and creates nothing",
    async (tool) => {
      await withVault({ ...CHECKED, files: { ...FILES, "lax/big.md": OVER_BOUND } }, async (v) => {
        const r = await confirmedCall(v, tool, {
          vault: "test",
          from: "lax/big.md",
          to: "meetings/big.md",
        });
        expect(r.ok ? "ok" : r.error.code).toBe("convention_blocked");
        expect(existsSync(join(v.root, "lax/big.md"))).toBe(true);
        expect(existsSync(join(v.root, "meetings/big.md"))).toBe(false);
      });
    },
  );
});

/** A vault with the M6 bulk writers registered over the same folder rules. */
function bulkVault(
  files: Record<string, string>,
  acl?: { readPaths: string[]; writePaths: string[] },
) {
  return makeM6Vault({
    conventions: true,
    ...(acl ? { acl } : {}),
    files,
    register: (reg, deps) =>
      registerM6Tools(reg, {
        ...deps,
        toolSurface: () => ({ config: reg.visibilityConfig(), tools: reg.list() }),
      }),
  });
}

describe("bulk_move_notes judges each row against its source", () => {
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

  it.each([true, false])(
    "bulk_move_notes (dry_run %s) refuses a readable note over 1 MiB into a stricter folder and writes nothing",
    async (dry_run) => {
      const v = bulkVault({ ...FILES, "lax/big.md": OVER_BOUND });
      try {
        const r = await v.callConfirmed("bulk_move_notes", {
          vault: "test",
          dry_run,
          moves: [{ from: "lax/big.md", to: "meetings/big.md" }],
        });
        if (dry_run) {
          expect(r.ok ? "ok" : JSON.stringify(r.error)).toBe("ok");
          const results = r.ok
            ? (r.data as { results: { would_block?: { code: string } }[] }).results
            : [];
          expect(results.map((x) => x.would_block?.code)).toEqual(["convention_blocked"]);
        } else {
          expect(r.ok ? "ok" : r.error.code).toBe("convention_blocked");
        }
        expect(existsSync(join(v.root, "lax/big.md"))).toBe(true);
        expect(existsSync(join(v.root, "meetings/big.md"))).toBe(false);
      } finally {
        v.cleanup();
      }
    },
  );

  it("dry_run shows no would_block for a same-folder rename of a non-compliant note", async () => {
    const v = bulkVault({ ...FILES, "meetings/a.md": BAD });
    try {
      const r = await v.callConfirmed("bulk_move_notes", {
        vault: "test",
        dry_run: true,
        moves: [{ from: "meetings/a.md", to: "meetings/b.md" }],
      });
      expect(r.ok ? "ok" : JSON.stringify(r.error)).toBe("ok");
      const results = r.ok ? (r.data as { results: { would_block?: unknown }[] }).results : [];
      expect(results.map((x) => x.would_block)).toEqual([undefined]);
      expect(v.read("meetings/a.md")).toBe(BAD);
    } finally {
      v.cleanup();
    }
  });

  it("a bulk move from a source the caller cannot read is refused in dry_run and the real run, echoing none of it", async () => {
    const acl = { readPaths: ["**/SCHEMA.md"], writePaths: ["**"] };
    const files = { ...FILES, "locked/a.md": LOCKED };
    const moves = [{ from: "locked/a.md", to: "meetings/a.md" }];
    const dry = bulkVault(files, acl);
    try {
      const r = await dry.callConfirmed("bulk_move_notes", { vault: "test", dry_run: true, moves });
      expect(r.ok).toBe(false);
      expectNoSecret(r);
    } finally {
      dry.cleanup();
    }
    const v = bulkVault(files, acl);
    try {
      const r = await v.callConfirmed("bulk_move_notes", { vault: "test", dry_run: false, moves });
      expect(r.ok).toBe(false);
      expectNoSecret(r);
      expect(existsSync(join(v.root, "locked/a.md"))).toBe(true);
      expect(existsSync(join(v.root, "meetings/a.md"))).toBe(false);
    } finally {
      v.cleanup();
    }
  });

  it("a refused overwrite batch leaves no .trash entry and the destination unchanged", async () => {
    const v = bulkVault({ ...FILES, "lax/a.md": BAD, "meetings/dst.md": GOOD });
    try {
      const r = await v.callConfirmed("bulk_move_notes", {
        vault: "test",
        dry_run: false,
        overwrite: true,
        moves: [{ from: "lax/a.md", to: "meetings/dst.md" }],
      });
      expect(r.ok ? "ok" : r.error.code).toBe("convention_blocked");
      expect(v.read("meetings/dst.md")).toBe(GOOD);
      expect(existsSync(join(v.root, "lax/a.md"))).toBe(true);
      expect(existsSync(join(v.root, ".trash"))).toBe(false);
    } finally {
      v.cleanup();
    }
  });
});

describe("a move whose only change is its own repointed links is not refused", () => {
  it("bulk-moves two linked notes between folders with identical rules, dry_run and real run", async () => {
    const schema =
      '---\nconventions:\n  frontmatter:\n    values: { related: ["[[zz/keep]]"] }\n    severity: { related: block }\n---\n# rules\n';
    const files = {
      "old/SCHEMA.md": schema,
      "new/SCHEMA.md": schema,
      "old/a.md": '---\nrelated: "[[old/b]]"\n---\nbody a\n',
      "old/b.md": '---\nrelated: "[[zz/keep]]"\n---\nbody b\n',
    };
    const moves = [
      { from: "old/a.md", to: "new/a.md" },
      { from: "old/b.md", to: "new/b.md" },
    ];
    const dry = bulkVault(files);
    try {
      const r = await dry.callConfirmed("bulk_move_notes", { vault: "test", dry_run: true, moves });
      expect(r.ok ? "ok" : JSON.stringify(r.error)).toBe("ok");
      const results = r.ok ? (r.data as { results: { would_block?: unknown }[] }).results : [];
      expect(results.map((x) => x.would_block)).toEqual([undefined, undefined]);
    } finally {
      dry.cleanup();
    }
    const v = bulkVault(files);
    try {
      const r = await v.callConfirmed("bulk_move_notes", { vault: "test", dry_run: false, moves });
      expect(r.ok ? "ok" : JSON.stringify(r.error)).toBe("ok");
      expect(v.read("new/a.md")).not.toContain("[[old/b]]");
      expect(existsSync(join(v.root, "old/a.md"))).toBe(false);
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
