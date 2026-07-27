// THE-602 wave 2 — additional real-behavior tests for src/tools/m6/bulk-tools.ts branches that
// test/m6-bulk.test.ts and test/bulk-executor.test.ts don't reach: the newTargetFor/rewriteForMoves
// link-rewrite edge cases, bulk_create_notes' folder/overwrite-mode guards, bulk_move_notes'
// in-batch chained/claimed-destination hazard detection, its non-ObsidianTcError error-wrapping,
// and the update_backlinks:false toggle on both dry_run and real moves. Every assertion is on
// caller-visible behavior (a returned error code/message, a file that was or wasn't written, a
// backlink count) — never a bare "did not throw".
//
// noteExists/readNote are wrapped (not replaced) so every OTHER call in this file still runs the
// real implementation; only a test that sets the matching *ThrowFor variable forces a raw,
// non-ObsidianTcError throw, proving the row-validation and phase-2 catch blocks in
// bulk_move_notes wrap ANY thrown error into an internal_error, not just ObsidianTcError.
import { ObsidianTcError, type ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBulkTools } from "../src/tools/m6/bulk-tools";
import { type M6Vault, makeM6Vault } from "./m6-helpers";

let noteExistsThrowFor: string | null = null;
let readNoteThrowFor: string | null = null;
let trashNoteThrowFor: string | null = null;

vi.mock("../src/vault/notes-io", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/vault/notes-io")>();
  return {
    ...actual,
    noteExists: (abs: string) => {
      if (noteExistsThrowFor && abs.includes(noteExistsThrowFor)) {
        throw new Error(`simulated stat failure on ${noteExistsThrowFor}`);
      }
      return actual.noteExists(abs);
    },
    readNote: (abs: string) => {
      if (readNoteThrowFor && abs.includes(readNoteThrowFor)) {
        throw new Error(`simulated read failure on ${readNoteThrowFor}`);
      }
      return actual.readNote(abs);
    },
    // Real trashNote only ever throws raw fs errors, never an ObsidianTcError — this stand-in
    // simulates a domain error surfacing mid-move (e.g. a lower layer that DOES throw one) to
    // prove the phase-2 catch passes an already-ObsidianTcError through unchanged instead of
    // re-wrapping it as internal_error.
    trashNote: (root: string, relPath: string) => {
      if (trashNoteThrowFor && relPath.includes(trashNoteThrowFor)) {
        throw new ObsidianTcError(
          "vault_not_found",
          `simulated vault loss on ${trashNoteThrowFor}`,
        );
      }
      return actual.trashNote(root, relPath);
    },
  };
});

const register = (
  r: import("../src/mcp/registry").ToolRegistry,
  d: import("../src/tools/m6/shared").M6Deps,
) => {
  for (const t of buildBulkTools(d)) r.register(t);
};

function data<T = Record<string, unknown>>(r: ToolResult): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as T;
}

let v: M6Vault | undefined;
afterEach(() => {
  v?.cleanup();
  noteExistsThrowFor = null;
  readNoteThrowFor = null;
  trashNoteThrowFor = null;
});

describe("bulk_create_notes — folder guard and overwrite mode", () => {
  it("fails an item whose path is an existing folder (invalid_input), leaves it untouched", async () => {
    v = makeM6Vault({ files: { "Docs/keep.md": "K" }, register });
    const out = data<{
      failed: number;
      succeeded: number;
      results: { path: string; ok: boolean; error?: { code: string } }[];
    }>(
      await v.callConfirmed("bulk_create_notes", {
        vault: "test",
        items: [
          { path: "Docs", content: "should not land" },
          { path: "fresh.md", content: "F" },
        ],
      }),
    );
    expect(out.succeeded).toBe(1);
    expect(out.failed).toBe(1);
    const bad = out.results.find((r) => r.path === "Docs");
    expect(bad?.ok).toBe(false);
    expect(bad?.error?.code).toBe("invalid_input");
    expect(v.exists("Docs/keep.md")).toBe(true); // folder contents untouched
    expect(v.exists("fresh.md")).toBe(true);
  });

  it("mode:overwrite on a missing note fails that item with note_not_found", async () => {
    v = makeM6Vault({ register });
    const out = data<{
      failed: number;
      results: { path: string; ok: boolean; error?: { code: string } }[];
    }>(
      await v.callConfirmed("bulk_create_notes", {
        vault: "test",
        items: [{ path: "missing.md", content: "X", mode: "overwrite" }],
      }),
    );
    expect(out.failed).toBe(1);
    expect(out.results[0]?.error?.code).toBe("note_not_found");
    expect(v.exists("missing.md")).toBe(false);
  });

  it("mode:overwrite on an existing note succeeds and reports mode_used overwrite", async () => {
    v = makeM6Vault({ files: { "a.md": "old" }, register });
    const out = data<{
      succeeded: number;
      results: { path: string; ok: boolean; mode_used?: string }[];
    }>(
      await v.callConfirmed("bulk_create_notes", {
        vault: "test",
        items: [{ path: "a.md", content: "new", mode: "overwrite" }],
      }),
    );
    expect(out.succeeded).toBe(1);
    expect(out.results[0]?.mode_used).toBe("overwrite");
    expect(v.read("a.md")).toBe("new");
  });
});

describe("bulk_move_notes — link-rewrite target selection (newTargetFor)", () => {
  it("uses the bare basename when the moved note's destination basename is unique vault-wide", async () => {
    v = makeM6Vault({ files: { "A.md": "# A", "B.md": "see [[A]]" }, register });
    const out = data<{ total_backlinks_updated: number }>(
      await v.callConfirmed("bulk_move_notes", {
        vault: "test",
        dry_run: false,
        moves: [{ from: "A.md", to: "Sub/C.md" }], // destination has a folder segment
      }),
    );
    expect(out.total_backlinks_updated).toBe(1);
    expect(v.exists("Sub/C.md")).toBe(true);
    expect(v.read("B.md")).toBe("see [[C]]"); // unique basename -> bare link
  });

  it("falls back to the extension-less full path when the destination basename collides", async () => {
    v = makeM6Vault({
      files: { "A.md": "# A", "Dup/C.md": "other note", "B.md": "see [[A]]" },
      register,
    });
    const out = data<{ total_backlinks_updated: number }>(
      await v.callConfirmed("bulk_move_notes", {
        vault: "test",
        dry_run: false,
        moves: [{ from: "A.md", to: "Sub/C.md" }], // now "C" exists twice (Dup/C.md, Sub/C.md)
      }),
    );
    expect(out.total_backlinks_updated).toBe(1);
    expect(v.read("B.md")).toBe("see [[Sub/C]]"); // ambiguous -> full path, no extension
    expect(v.read("Dup/C.md")).toBe("other note"); // the pre-existing collider is untouched
  });

  it("skips an unresolved link and a link to a note that isn't part of the move", async () => {
    v = makeM6Vault({
      files: {
        "A.md": "# A",
        "Other.md": "# other",
        "B.md": "see [[A]] and [[Ghost]] and [[Other]]",
      },
      register,
    });
    const out = data<{ total_backlinks_updated: number }>(
      await v.callConfirmed("bulk_move_notes", {
        vault: "test",
        dry_run: false,
        moves: [{ from: "A.md", to: "C.md" }],
      }),
    );
    expect(out.total_backlinks_updated).toBe(1); // only [[A]] counted
    expect(v.read("B.md")).toBe("see [[C]] and [[Ghost]] and [[Other]]");
  });
});

describe("bulk_move_notes — in-batch hazard detection", () => {
  it("rejects both legs of a chained move (dest-is-a-source and source-is-a-dest)", async () => {
    v = makeM6Vault({ files: { "A.md": "AA", "B.md": "BB" }, register });
    const out = data<{
      results: {
        from: string;
        to: string;
        ok: boolean;
        error?: { code: string; message: string };
      }[];
    }>(
      await v.callConfirmed("bulk_move_notes", {
        vault: "test",
        dry_run: false,
        overwrite: true, // A -> B needs it since B.md pre-exists
        moves: [
          { from: "A.md", to: "B.md" },
          { from: "B.md", to: "C.md" },
        ],
      }),
    );
    const r1 = out.results.find((r) => r.from === "A.md" && r.to === "B.md");
    const r2 = out.results.find((r) => r.from === "B.md" && r.to === "C.md");
    expect(r1?.ok).toBe(false);
    expect(r1?.error?.code).toBe("invalid_input");
    expect(r1?.error?.message).toContain("destination is also a source");
    expect(r2?.ok).toBe(false);
    expect(r2?.error?.code).toBe("invalid_input");
    expect(r2?.error?.message).toContain("source is also a destination");
    // Neither leg of the rejected chain touched disk.
    expect(v.exists("A.md")).toBe(true);
    expect(v.exists("B.md")).toBe(true);
    expect(v.exists("C.md")).toBe(false);
  });

  it("rejects the second of two moves claiming the same free destination", async () => {
    v = makeM6Vault({ files: { "X.md": "X", "Y.md": "Y" }, register });
    const out = data<{
      results: { from: string; ok: boolean; error?: { code: string; message: string } }[];
    }>(
      await v.callConfirmed("bulk_move_notes", {
        vault: "test",
        dry_run: false,
        moves: [
          { from: "X.md", to: "Z.md" },
          { from: "Y.md", to: "Z.md" },
        ],
      }),
    );
    const r1 = out.results.find((r) => r.from === "X.md");
    const r2 = out.results.find((r) => r.from === "Y.md");
    expect(r1?.ok).toBe(true);
    expect(r2?.ok).toBe(false);
    expect(r2?.error?.code).toBe("invalid_input");
    expect(r2?.error?.message).toContain("already claimed");
    expect(v.exists("Z.md")).toBe(true);
    expect(v.read("Z.md")).toBe("X"); // the winning move's content
    expect(v.exists("X.md")).toBe(false);
    expect(v.exists("Y.md")).toBe(true); // the rejected move's source is untouched
  });

  it("rejects from===to as invalid_input without touching the file", async () => {
    v = makeM6Vault({ files: { "A.md": "AA" }, register });
    const out = data<{ results: { ok: boolean; error?: { code: string } }[] }>(
      await v.callConfirmed("bulk_move_notes", {
        vault: "test",
        dry_run: false,
        moves: [{ from: "A.md", to: "A.md" }],
      }),
    );
    expect(out.results[0]?.ok).toBe(false);
    expect(out.results[0]?.error?.code).toBe("invalid_input");
    expect(v.read("A.md")).toBe("AA");
  });
});

describe("bulk_move_notes — non-ObsidianTcError wrapping", () => {
  it("wraps a raw throw during row validation as internal_error", async () => {
    v = makeM6Vault({ files: { "A.md": "AA" }, register });
    noteExistsThrowFor = "A.md";
    const out = data<{ results: { from: string; ok: boolean; error?: { code: string } }[] }>(
      await v.callConfirmed("bulk_move_notes", {
        vault: "test",
        dry_run: false,
        moves: [{ from: "A.md", to: "B.md" }],
      }),
    );
    expect(out.results[0]?.ok).toBe(false);
    expect(out.results[0]?.error?.code).toBe("internal_error");
    expect(v.exists("A.md")).toBe(true); // never got past validation
  });

  it("wraps a raw throw during the real-move phase as internal_error, isolated to that row", async () => {
    v = makeM6Vault({ files: { "A.md": "AA", "D.md": "DD" }, register });
    readNoteThrowFor = "A.md";
    const out = data<{
      total_backlinks_updated: number;
      results: {
        from: string;
        ok: boolean;
        error?: { code: string };
        backlinks_updated?: number;
      }[];
    }>(
      await v.callConfirmed("bulk_move_notes", {
        vault: "test",
        dry_run: false,
        moves: [
          { from: "A.md", to: "A2.md" },
          { from: "D.md", to: "D2.md" },
        ],
      }),
    );
    const bad = out.results.find((r) => r.from === "A.md");
    const good = out.results.find((r) => r.from === "D.md");
    expect(bad?.ok).toBe(false);
    expect(bad?.error?.code).toBe("internal_error");
    expect(v.exists("A.md")).toBe(true); // the crashed row's source is left in place, not lost
    expect(v.exists("A2.md")).toBe(false);
    expect(good?.ok).toBe(true);
    expect(good?.backlinks_updated).toBe(0); // no note referenced D.md -> the ?? 0 fallback
    expect(v.exists("D2.md")).toBe(true);
  });

  it("passes an already-ObsidianTcError thrown mid-move through unchanged (not re-wrapped)", async () => {
    v = makeM6Vault({ files: { "A.md": "AA", "C.md": "old-C" }, register });
    trashNoteThrowFor = "C.md"; // fires inside the destExists+overwrite trash step
    const out = data<{ results: { from: string; ok: boolean; error?: { code: string } }[] }>(
      await v.callConfirmed("bulk_move_notes", {
        vault: "test",
        dry_run: false,
        overwrite: true,
        moves: [{ from: "A.md", to: "C.md" }],
      }),
    );
    expect(out.results[0]?.ok).toBe(false);
    expect(out.results[0]?.error?.code).toBe("vault_not_found"); // preserved, not "internal_error"
    expect(v.read("C.md")).toBe("old-C"); // destination untouched — the crash preceded the write
    expect(v.exists("A.md")).toBe(true); // source never deleted
  });
});

describe("bulk_move_notes — update_backlinks:false skips the rewrite pass", () => {
  it("dry_run preview reports zero backlinks and zero per-row when disabled", async () => {
    v = makeM6Vault({ files: { "A.md": "# A", "B.md": "see [[A]]" }, register });
    const out = data<{
      dry_run: boolean;
      total_backlinks_updated: number;
      results: { ok: boolean; backlinks_updated?: number }[];
    }>(
      await v.callConfirmed("bulk_move_notes", {
        vault: "test",
        update_backlinks: false,
        moves: [{ from: "A.md", to: "C.md" }],
      }),
    );
    expect(out.dry_run).toBe(true);
    expect(out.total_backlinks_updated).toBe(0);
    expect(out.results[0]?.backlinks_updated).toBe(0);
  });

  it("a real move leaves stale backlinks in place when disabled", async () => {
    v = makeM6Vault({ files: { "A.md": "# A", "B.md": "see [[A]]" }, register });
    const out = data<{ total_backlinks_updated: number }>(
      await v.callConfirmed("bulk_move_notes", {
        vault: "test",
        dry_run: false,
        update_backlinks: false,
        moves: [{ from: "A.md", to: "C.md" }],
      }),
    );
    expect(out.total_backlinks_updated).toBe(0);
    expect(v.exists("C.md")).toBe(true);
    expect(v.exists("A.md")).toBe(false);
    expect(v.read("B.md")).toBe("see [[A]]"); // NOT rewritten — now a dangling link, by design
  });
});

describe("bulk_move_notes — dry_run result shape mixes ok and error rows", () => {
  it("reports backlinks_updated:0 for a linkless move alongside an error row, still in preview", async () => {
    v = makeM6Vault({ files: { "A.md": "# A" }, register }); // no note links to A.md
    const out = data<{
      dry_run: boolean;
      results: {
        from: string;
        ok: boolean;
        backlinks_updated?: number;
        error?: { code: string };
      }[];
    }>(
      await v.callConfirmed("bulk_move_notes", {
        vault: "test",
        moves: [
          { from: "A.md", to: "C.md" },
          { from: "ghost.md", to: "x.md" },
        ],
      }),
    );
    expect(out.dry_run).toBe(true);
    const good = out.results.find((r) => r.from === "A.md");
    const bad = out.results.find((r) => r.from === "ghost.md");
    expect(good?.ok).toBe(true);
    expect(good?.backlinks_updated).toBe(0);
    expect(bad?.ok).toBe(false);
    expect(bad?.error?.code).toBe("note_not_found");
    expect(v.exists("C.md")).toBe(false); // still just a preview
  });
});
