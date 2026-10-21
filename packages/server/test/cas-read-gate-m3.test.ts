// Structured-document writes are content-dependent: a caller that may not read the document is
// refused before anything is read, and a reader still reaches the tool's own checks. Covers the
// table, Kanban, canvas and base tools (the m3 set); the m1 set lives in cas-read-gate.test.ts.
import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { afterEach, describe, expect, it } from "vitest";
import { type M3Vault, makeM3Vault } from "./m3-helpers";

const FIXED_REFUSAL = "this operation needs read access to the target";
const SCOPES = {
  grantedScopes: new Set([
    "read:notes",
    "write:notes",
    "read:canvas",
    "write:canvas",
    "read:bases",
    "write:bases",
  ]),
};
const WRITE_ONLY_ACL = { readPaths: ["Public/**"], writePaths: ["**"], deletePaths: ["**"] };
const READER_ACL = { writePaths: ["**"], deletePaths: ["**"] };

const TABLE = "| a | b |\n|---|---|\n| PIN 4821 | x |\n";
const BOARD = "---\nkanban-plugin: board\n---\n\n## Todo\n\n- [ ] PIN 4821\n";
const CANVAS = JSON.stringify(
  {
    nodes: [{ id: "a", type: "text", text: "PIN 4821", x: 0, y: 0, width: 10, height: 10 }],
    edges: [],
  },
  null,
  "\t",
);
const BASE = "views:\n  - type: table\n    name: PIN 4821\n";

/** Every structured-document write, each with one valid minimal argument set. */
const STRUCTURED: Array<[string, string, Record<string, unknown>, string]> = [
  ["format_table", "format_table", { path: "Private/t.md" }, TABLE],
  ["insert_table_row", "insert_table_row", { path: "Private/t.md", values: ["x", "y"] }, TABLE],
  [
    "insert_table_column",
    "insert_table_column",
    { path: "Private/t.md", header: "c", values: ["1"] },
    TABLE,
  ],
  ["sort_table_by_column", "sort_table_by_column", { path: "Private/t.md", column: 0 }, TABLE],
  [
    "add_kanban_card",
    "add_kanban_card",
    { path: "Private/b.md", column: "Todo", text: "x" },
    BOARD,
  ],
  [
    "move_kanban_card",
    "move_kanban_card",
    { path: "Private/b.md", from_column: "Todo", to_column: "Done", card_text: "PIN 4821" },
    BOARD,
  ],
  [
    "update_canvas",
    "update_canvas",
    {
      path: "Private/c.canvas",
      add_nodes: [{ id: "b", type: "text", text: "y", x: 0, y: 0, width: 10, height: 10 }],
    },
    CANVAS,
  ],
  [
    "update_base",
    "update_base",
    { path: "Private/d.base", patch: { add_views: [{ type: "table", name: "v" }] } },
    BASE,
  ],
];

const errOf = (r: ToolResult): { code: string; message: string } | null =>
  r.ok ? null : (r.error as { code: string; message: string });

let v: M3Vault | undefined;
afterEach(() => {
  v?.cleanup();
  v = undefined;
});

describe("content-dependent structured writes: a non-reader is refused, a reader is not", () => {
  it.each(STRUCTURED)(
    "structured: %s refuses a non-reader with the fixed error and writes nothing",
    async (_name, tool, args, content) => {
      const path = String(args.path);
      v = makeM3Vault({ files: { [path]: content }, acl: WRITE_ONLY_ACL });
      const r = await v.call(tool, { vault: "test", ...args }, SCOPES);
      expect(errOf(r)?.code, tool).toBe("invalid_input");
      expect(errOf(r)?.message, tool).toBe(FIXED_REFUSAL);
      expect(JSON.stringify(r), tool).not.toContain("4821");
      expect(v.read(path), tool).toBe(content);
    },
  );

  it.each(STRUCTURED)(
    "structured: %s still reaches the checks of a reader",
    async (_name, tool, args, content) => {
      const path = String(args.path);
      v = makeM3Vault({ files: { [path]: content }, acl: READER_ACL });
      const r = await v.call(tool, { vault: "test", ...args }, SCOPES);
      expect(errOf(r)?.message, tool).not.toBe(FIXED_REFUSAL);
    },
  );
});
