// THE-602: branch-coverage top-up for src/tools/m3/table-tools.ts. Every test asserts real
// caller-visible behavior (a returned value, a written note's content, or an error code/shape) —
// no test merely executes a line without checking an outcome.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeM3Vault } from "./m3-helpers";

describe("THE-602 table-tools branch coverage", () => {
  // splitRow escape handling (line ~34): `\|` unescapes to a literal pipe inside a cell;
  // a bare backslash NOT followed by `|` is kept literally. Both legs of the `&&` exercised
  // in one row so we see both outcomes reflected in the re-serialized note.
  it("splitRow unescapes \\| to a literal pipe and preserves a lone backslash", async () => {
    const note = "| Name | Note |\n|---|---|\n| bob | a\\|b |\n| ann | c\\d |\n";
    const v = makeM3Vault({ files: { "t.md": note } });
    try {
      const r = await v.call("format_table", { vault: "test", path: "t.md" });
      expect(r.ok).toBe(true);
      const out = v.read("t.md");
      // escaped pipe became a literal `|` in the cell content
      expect(out).toMatch(/\|\s*bob\s*\|\s*a\|b\s*\|/);
      // lone backslash (not followed by `|`) survives untouched
      expect(out).toMatch(/\|\s*ann\s*\|\s*c\\d\s*\|/);
    } finally {
      v.cleanup();
    }
  });

  // alignOf ternary (line ~58): all four outcomes (center / right / left / none) from the
  // delimiter row's colon placement, round-tripped through format_table and asserted on the
  // regenerated delimiter line.
  it("alignOf recognizes center, right, left and none from delimiter colons", async () => {
    const note = "| A | B | C | D |\n|:-:|-:|:-|---|\n| 1 | 2 | 3 | 4 |\n";
    const v = makeM3Vault({ files: { "t.md": note } });
    try {
      const r = await v.call("format_table", { vault: "test", path: "t.md" });
      expect(r.ok).toBe(true);
      const out = v.read("t.md");
      const delimLine = out.split("\n")[1] ?? "";
      const cells = delimLine
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim());
      expect(cells[0]).toMatch(/^:-+:$/); // center
      expect(cells[1]).toMatch(/^-+:$/); // right
      expect(cells[2]).toMatch(/^:-+$/); // left
      expect(cells[3]).toMatch(/^-+$/); // none
    } finally {
      v.cleanup();
    }
  });

  // pad() center-alignment with an ODD gap (line ~92-99): floor(gap/2) on the left, the
  // remainder on the right — asserted via exact spacing, not just "it ran".
  it("pad() splits an odd center gap floor-left / ceil-right", async () => {
    // header "Wide" (4 chars) forces width 4; content "x" (1 char) leaves a gap of 3 (odd).
    const note = "| Wide |\n|:-:|\n| x |\n";
    const v = makeM3Vault({ files: { "t.md": note } });
    try {
      const r = await v.call("format_table", { vault: "test", path: "t.md" });
      expect(r.ok).toBe(true);
      const out = v.read("t.md");
      const rowLine = out.split("\n")[2] ?? "";
      // gap=3 -> left=floor(3/2)=1, right=2: "| " + 1sp + "x" + 2sp + " |"
      expect(rowLine).toBe("|  x   |");
    } finally {
      v.cleanup();
    }
  });

  // parseTables guards (line ~73-77): a header/delimiter pair is rejected — no table is
  // recognized — when either row lacks a pipe, or when the delimiter isn't delimiter-shaped,
  // or when header/delimiter column counts differ. All three assert via the same observable
  // outcome: format_table on table_index 0 fails with invalid_input (no table found).
  it("rejects a header line with no pipe as a table", async () => {
    const note = "Name Age\n|---|---|\n| bob | 3 |\n";
    const v = makeM3Vault({ files: { "t.md": note } });
    try {
      const r = await v.call("format_table", { vault: "test", path: "t.md" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("rejects a second line that isn't delimiter-shaped as a table", async () => {
    const note = "| Name | Age |\n| foo | bar |\n| 1 | 2 |\n";
    const v = makeM3Vault({ files: { "t.md": note } });
    try {
      const r = await v.call("format_table", { vault: "test", path: "t.md" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  it("rejects a header/delimiter with mismatched column counts", async () => {
    const note = "| A | B |\n|---|\n| 1 | 2 |\n";
    const v = makeM3Vault({ files: { "t.md": note } });
    try {
      const r = await v.call("format_table", { vault: "test", path: "t.md" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  // Row-collection stop conditions (line ~82-83): a blank line ends the table (already implied
  // elsewhere) vs. a non-blank line with no pipe ends the table — the OR's second operand,
  // asserted distinctly by NOT having a blank line before the trailing prose.
  it("stops collecting rows at a non-blank, pipe-less line (no blank line first)", async () => {
    const note = "| A | B |\n|---|---|\n| 1 | 2 |\nnot a table row\n";
    const v = makeM3Vault({ files: { "t.md": note } });
    try {
      const r = await v.call("format_table", { vault: "test", path: "t.md" });
      expect(r.ok).toBe(true);
      const out = v.read("t.md");
      expect(out).toContain("not a table row");
      // only one data row was absorbed into the table
      if (r.ok) expect((r.data as { rows: number }).rows).toBe(1);
    } finally {
      v.cleanup();
    }
  });

  // fitRow (line ~61-65): a short row is padded with "" cells; a long row is truncated to the
  // header's column count. Both legs asserted on the re-serialized output.
  it("pads a short row and truncates a long row to the header's column count", async () => {
    const note = "| A | B | C |\n|---|---|---|\n| 1 | 2 |\n| 3 | 4 | 5 | 6 |\n";
    const v = makeM3Vault({ files: { "t.md": note } });
    try {
      const r = await v.call("format_table", { vault: "test", path: "t.md" });
      expect(r.ok).toBe(true);
      const out = v.read("t.md");
      const lines = out.split("\n");
      // short row "1, 2" gets a padded empty 3rd cell
      expect(lines[2]).toMatch(/^\|\s*1\s*\|\s*2\s*\|\s*\|$/);
      // long row is truncated: "6" must not appear anywhere in the output
      expect(out).not.toContain("6");
      expect(lines[3]).toMatch(/^\|\s*3\s*\|\s*4\s*\|\s*5\s*\|$/);
    } finally {
      v.cleanup();
    }
  });

  // withTable guards: path exists but is a directory -> note_not_found (the `ex.type ===
  // "folder"` leg, distinct from `!ex.exists`).
  it("errors note_not_found when the path is a folder, not a note", async () => {
    const v = makeM3Vault({ files: { "keep.md": "x" } });
    try {
      mkdirSync(join(v.root, "a-folder"), { recursive: true });
      const r = await v.call("format_table", { vault: "test", path: "a-folder" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("note_not_found");
    } finally {
      v.cleanup();
    }
  });

  // withTable guards: prev_hash present and MATCHING succeeds (distinct from the default-omitted
  // case exercised elsewhere, and from the mismatching case below) — both legs of the `&&`.
  it("accepts a matching prev_hash and rejects a mismatching one", async () => {
    const note = "| A | B |\n|---|---|\n| 1 | 2 |\n";
    const v = makeM3Vault({ files: { "t.md": note } });
    try {
      const first = await v.call("format_table", { vault: "test", path: "t.md" });
      expect(first.ok).toBe(true);
      const hash = first.ok ? (first.data as { content_hash: string }).content_hash : "";
      const bad = await v.call("format_table", {
        vault: "test",
        path: "t.md",
        prev_hash: "deadbeef".repeat(4),
      });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error.code).toBe("concurrent_modification");
      const good = await v.call("format_table", { vault: "test", path: "t.md", prev_hash: hash });
      expect(good.ok).toBe(true);
    } finally {
      v.cleanup();
    }
  });

  // withTable guard: table_index points past the end of a note that DOES have a table (distinct
  // from the "no tables at all" case already covered in tables.test.ts).
  it("errors invalid_input when table_index is out of range on a note with one table", async () => {
    const note = "| A | B |\n|---|---|\n| 1 | 2 |\n";
    const v = makeM3Vault({ files: { "t.md": note } });
    try {
      const r = await v.call("format_table", { vault: "test", path: "t.md", table_index: 3 });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("invalid_input");
        expect(r.error.details).toMatchObject({ table_index: 3 });
      }
    } finally {
      v.cleanup();
    }
  });

  // deps.reindex?.() optional-chain: the truthy leg — a supplied hook is actually invoked with
  // the vault id, relative path and the POST-write content.
  it("invokes a supplied reindex hook with the post-write content", async () => {
    const note = "| A | B |\n|---|---|\n| 1 | 2 |\n";
    const calls: Array<{ vaultId: string; rel: string; content: string }> = [];
    const v = makeM3Vault({
      files: { "t.md": note },
      reindex: (vaultId, rel, content) => {
        calls.push({ vaultId, rel, content });
      },
    });
    try {
      const r = await v.call("insert_table_row", {
        vault: "test",
        path: "t.md",
        values: ["9", "9"],
      });
      expect(r.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.vaultId).toBe("test");
      expect(calls[0]?.rel).toBe("t.md");
      expect(calls[0]?.content).toContain("9");
    } finally {
      v.cleanup();
    }
  });

  // colIndex (line ~173-178): the numeric leg (returned verbatim), the string-not-found leg
  // (invalid_input), and case/whitespace-insensitive header matching on the found leg.
  it("colIndex accepts a numeric column index directly", async () => {
    const note = "| A | B |\n|---|---|\n| 3 | 1 |\n| 1 | 2 |\n";
    const v = makeM3Vault({ files: { "t.md": note } });
    try {
      const r = await v.call("sort_table_by_column", {
        vault: "test",
        path: "t.md",
        column: 0,
        numeric: true,
      });
      expect(r.ok).toBe(true);
      const dataRows = v.read("t.md").split("\n").slice(2, 4);
      expect(dataRows[0]).toMatch(/^\|\s*1\s*\|/);
      expect(dataRows[1]).toMatch(/^\|\s*3\s*\|/);
    } finally {
      v.cleanup();
    }
  });

  it("colIndex matches a header name case- and whitespace-insensitively", async () => {
    const note = "| Age |\n|---|\n| 10 |\n| 3 |\n";
    const v = makeM3Vault({ files: { "t.md": note } });
    try {
      const r = await v.call("sort_table_by_column", {
        vault: "test",
        path: "t.md",
        column: "  AGE  ",
        numeric: true,
      });
      expect(r.ok).toBe(true);
      const dataRows = v.read("t.md").split("\n").slice(2, 4);
      expect(dataRows[0]).toMatch(/\|\s*3\s*\|/);
      expect(dataRows[1]).toMatch(/\|\s*10\s*\|/);
    } finally {
      v.cleanup();
    }
  });

  it("colIndex errors invalid_input on an unknown column name", async () => {
    const note = "| A | B |\n|---|---|\n| 1 | 2 |\n";
    const v = makeM3Vault({ files: { "t.md": note } });
    try {
      const r = await v.call("sort_table_by_column", {
        vault: "test",
        path: "t.md",
        column: "Nonexistent",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_input");
    } finally {
      v.cleanup();
    }
  });

  // insert_table_row `at` clamping (line ~230): `at` beyond the current row count clamps to
  // append rather than throwing or leaving a gap.
  it("insert_table_row clamps an out-of-range `at` to append", async () => {
    const note = "| A |\n|---|\n| 1 |\n| 2 |\n";
    const v = makeM3Vault({ files: { "t.md": note } });
    try {
      const r = await v.call("insert_table_row", {
        vault: "test",
        path: "t.md",
        values: ["3"],
        at: 999,
      });
      expect(r.ok).toBe(true);
      const dataRows = v.read("t.md").split("\n").slice(2, 5);
      // min column width is 3 (Math.max(3, w)), so single-char cells are padded to width 3
      expect(dataRows).toEqual(["| 1   |", "| 2   |", "| 3   |"]);
    } finally {
      v.cleanup();
    }
  });

  // insert_table_column: `at` explicitly provided inserts at that position (not just default
  // append); `at` beyond header length clamps to append; omitting `values` entirely falls back
  // to "" for every row via the optional-chain `?.[i] ?? ""`.
  it("insert_table_column inserts at an explicit position", async () => {
    const note = "| A | C |\n|---|---|\n| 1 | 3 |\n";
    const v = makeM3Vault({ files: { "t.md": note } });
    try {
      const r = await v.call("insert_table_column", {
        vault: "test",
        path: "t.md",
        header: "B",
        values: ["2"],
        at: 1,
      });
      expect(r.ok).toBe(true);
      // min column width is 3, so single-char headers are padded to width 3
      expect(v.read("t.md").split("\n")[0]).toBe("| A   | B   | C   |");
    } finally {
      v.cleanup();
    }
  });

  it("insert_table_column clamps an out-of-range `at` to append", async () => {
    const note = "| A |\n|---|\n| 1 |\n";
    const v = makeM3Vault({ files: { "t.md": note } });
    try {
      const r = await v.call("insert_table_column", {
        vault: "test",
        path: "t.md",
        header: "Z",
        at: 999,
      });
      expect(r.ok).toBe(true);
      expect(v.read("t.md").split("\n")[0]).toBe("| A   | Z   |");
    } finally {
      v.cleanup();
    }
  });

  it("insert_table_column fills every row with '' when `values` is omitted", async () => {
    const note = "| A |\n|---|\n| 1 |\n| 2 |\n";
    const v = makeM3Vault({ files: { "t.md": note } });
    try {
      const r = await v.call("insert_table_column", { vault: "test", path: "t.md", header: "B" });
      expect(r.ok).toBe(true);
      const dataRows = v.read("t.md").split("\n").slice(2, 4);
      expect(dataRows[0]).toBe("| 1   |     |");
      expect(dataRows[1]).toBe("| 2   |     |");
    } finally {
      v.cleanup();
    }
  });

  it("insert_table_column falls back to '' for rows past the end of a short `values` array", async () => {
    const note = "| A |\n|---|\n| 1 |\n| 2 |\n";
    const v = makeM3Vault({ files: { "t.md": note } });
    try {
      const r = await v.call("insert_table_column", {
        vault: "test",
        path: "t.md",
        header: "B",
        values: ["x"],
      });
      expect(r.ok).toBe(true);
      const dataRows = v.read("t.md").split("\n").slice(2, 4);
      expect(dataRows[0]).toBe("| 1   | x   |");
      expect(dataRows[1]).toBe("| 2   |     |");
    } finally {
      v.cleanup();
    }
  });

  // sort_table_by_column: the numeric-false (localeCompare) leg and the "desc" direction leg —
  // the existing suite only covers numeric:true/order:asc.
  it("sorts lexicographically (numeric:false) and descending", async () => {
    const note = "| Name |\n|---|\n| bob |\n| ann |\n| cy |\n";
    const v = makeM3Vault({ files: { "t.md": note } });
    try {
      const r = await v.call("sort_table_by_column", {
        vault: "test",
        path: "t.md",
        column: "Name",
        order: "desc",
      });
      expect(r.ok).toBe(true);
      const dataRows = v.read("t.md").split("\n").slice(2, 5);
      expect(dataRows.map((l) => l.trim())).toEqual(["| cy   |", "| bob  |", "| ann  |"]);
    } finally {
      v.cleanup();
    }
  });
});
