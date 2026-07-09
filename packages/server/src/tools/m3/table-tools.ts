// Domain — GFM markdown tables (THE-380, "Advanced Tables" capability). Pure-filesystem:
// parse the GFM tables in a note, mutate the addressed one (by 0-based index), re-serialize with
// aligned columns, splice back preserving the rest of the note. Four tools: format_table,
// insert_table_row, insert_table_column, sort_table_by_column. No plugin dependency (the data is
// plain markdown), so this works headlessly — an agent gets correct table alignment/edits without
// hand-rolling GFM padding.
import { err, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { noteExists, readNote, writeNoteAtomic } from "../../vault/notes-io";
import { contentHash, normalizeVaultPath, resolveVaultPath } from "../../vault/paths";
import { defineTool } from "../m1/define";
import type { M3Deps } from "./index";

type Align = "none" | "left" | "center" | "right";

interface Table {
  startLine: number;
  endLine: number; // exclusive
  header: string[];
  align: Align[];
  rows: string[][];
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function isDelimiterRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c.trim()));
}

function alignOf(cell: string): Align {
  const c = cell.trim();
  const l = c.startsWith(":");
  const r = c.endsWith(":");
  return l && r ? "center" : r ? "right" : l ? "left" : "none";
}

function fitRow(row: string[], n: number): string[] {
  const out = row.slice(0, n);
  while (out.length < n) out.push("");
  return out;
}

function parseTables(body: string): { lines: string[]; tables: Table[] } {
  const lines = body.split(/\r?\n/);
  const tables: Table[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const h = lines[i] ?? "";
    const d = lines[i + 1] ?? "";
    if (!h.includes("|") || !d.includes("|")) continue;
    const dcells = splitRow(d);
    if (!isDelimiterRow(dcells)) continue;
    const header = splitRow(h);
    if (header.length !== dcells.length) continue;
    const align = dcells.map(alignOf);
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length; j++) {
      const rl = lines[j] ?? "";
      if (rl.trim() === "" || !rl.includes("|")) break;
      rows.push(fitRow(splitRow(rl), header.length));
    }
    tables.push({ startLine: i, endLine: j, header, align, rows });
    i = j - 1;
  }
  return { lines, tables };
}

function pad(s: string, w: number, a: Align): string {
  const gap = Math.max(0, w - s.length);
  if (a === "right") return " ".repeat(gap) + s;
  if (a === "center") {
    const left = Math.floor(gap / 2);
    return " ".repeat(left) + s + " ".repeat(gap - left);
  }
  return s + " ".repeat(gap);
}

function delimFor(a: Align, w: number): string {
  const width = Math.max(3, w);
  if (a === "center") return `:${"-".repeat(width - 2)}:`;
  if (a === "left") return `:${"-".repeat(width - 1)}`;
  if (a === "right") return `${"-".repeat(width - 1)}:`;
  return "-".repeat(width);
}

function serializeTable(t: Table): string[] {
  const cols = t.header.length;
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = (t.header[c] ?? "").length;
    for (const r of t.rows) w = Math.max(w, (r[c] ?? "").length);
    widths[c] = Math.max(3, w);
  }
  const line = (cells: string[], fmt: (s: string, c: number) => string): string =>
    `| ${cells.map((cell, c) => fmt(cell ?? "", c)).join(" | ")} |`;
  const headerLine = line(t.header, (s, c) => pad(s, widths[c] ?? 3, "none"));
  const delimLine = `| ${t.align.map((a, c) => delimFor(a, widths[c] ?? 3)).join(" | ")} |`;
  const rowLines = t.rows.map((r) =>
    line(r, (s, c) => pad(s, widths[c] ?? 3, t.align[c] ?? "none")),
  );
  return [headerLine, delimLine, ...rowLines];
}

/** Read a note, locate the addressed GFM table, apply `fn` (mutates in place), re-serialize and
 *  splice it back, write. Returns the write summary. */
function withTable(
  deps: M3Deps,
  ctx: { acl?: import("../../acl").FolderAcl },
  vault: string,
  path: string,
  index: number,
  prevHash: string | undefined,
  fn: (t: Table) => void,
): Record<string, unknown> {
  const v = deps.vaultRegistry.resolve(vault);
  const rel = normalizeVaultPath(path);
  const abs = resolveVaultPath(v.root, rel);
  enforcePathAcl(ctx.acl, "write", rel, v.root);
  const ex = noteExists(abs);
  if (!ex.exists || ex.type === "folder") throw err.noteNotFound("note not found", { path: rel });
  const { raw, hash } = readNote(abs);
  if (prevHash !== undefined && prevHash !== hash)
    throw err.concurrentModification("note changed since prev_hash", {
      path: rel,
      expected: prevHash,
      actual: hash,
    });
  const { lines, tables } = parseTables(raw);
  const t = tables[index];
  if (!t) throw err.invalidInput("no GFM table at that index", { path: rel, table_index: index });
  fn(t);
  const rendered = serializeTable(t);
  const next = [...lines.slice(0, t.startLine), ...rendered, ...lines.slice(t.endLine)].join(
    raw.includes("\r\n") ? "\r\n" : "\n",
  );
  writeNoteAtomic(abs, next, false);
  deps.reindex?.(v.id, rel, next);
  return {
    vault: v.id,
    path: rel,
    table_index: index,
    rows: t.rows.length,
    columns: t.header.length,
    content_hash: contentHash(next),
    prev_hash: hash,
  };
}

function colIndex(t: Table, column: number | string): number {
  if (typeof column === "number") return column;
  const i = t.header.findIndex((h) => h.trim().toLowerCase() === column.trim().toLowerCase());
  if (i < 0) throw err.invalidInput("column not found", { column });
  return i;
}

const Base = { vault: VaultId, path: VaultPath, table_index: z.number().int().min(0).default(0) };

export function buildTableTools(deps: M3Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "format_table",
      description:
        "Reformat a GFM markdown table in a note: realign columns to a uniform width, honoring the delimiter row's alignment. Addressed by 0-based table_index within the note.",
      inputSchema: z.object({ ...Base, prev_hash: z.string().optional() }).strict(),
      requiredScopes: ["write:notes"],
      handler: (input, ctx) =>
        withTable(deps, ctx, input.vault, input.path, input.table_index, input.prev_hash, () => {}),
    }),

    defineTool({
      name: "insert_table_row",
      description:
        "Insert a data row into a GFM table. `values` are cell strings (padded/truncated to the column count); `at` is the 0-based data-row position (default: append).",
      inputSchema: z
        .object({
          ...Base,
          values: z.array(z.string()),
          at: z.number().int().min(0).optional(),
          prev_hash: z.string().optional(),
        })
        .strict(),
      requiredScopes: ["write:notes"],
      handler: (input, ctx) =>
        withTable(deps, ctx, input.vault, input.path, input.table_index, input.prev_hash, (t) => {
          const row = fitRow(input.values, t.header.length);
          const at = input.at === undefined ? t.rows.length : Math.min(input.at, t.rows.length);
          t.rows.splice(at, 0, row);
        }),
    }),

    defineTool({
      name: "insert_table_column",
      description:
        "Insert a column into a GFM table: a header plus per-row values (default empty) and an alignment. `at` is the 0-based column position (default: append).",
      inputSchema: z
        .object({
          ...Base,
          header: z.string(),
          values: z.array(z.string()).optional(),
          at: z.number().int().min(0).optional(),
          align: z.enum(["none", "left", "center", "right"]).default("none"),
          prev_hash: z.string().optional(),
        })
        .strict(),
      requiredScopes: ["write:notes"],
      handler: (input, ctx) =>
        withTable(deps, ctx, input.vault, input.path, input.table_index, input.prev_hash, (t) => {
          const at = input.at === undefined ? t.header.length : Math.min(input.at, t.header.length);
          t.header.splice(at, 0, input.header);
          t.align.splice(at, 0, input.align);
          t.rows.forEach((r, i) => {
            r.splice(at, 0, input.values?.[i] ?? "");
          });
        }),
    }),

    defineTool({
      name: "sort_table_by_column",
      description:
        "Sort a GFM table's data rows by a column (index or header name), ascending or descending, optionally numeric.",
      inputSchema: z
        .object({
          ...Base,
          column: z.union([z.number().int().min(0), z.string()]),
          order: z.enum(["asc", "desc"]).default("asc"),
          numeric: z.boolean().default(false),
          prev_hash: z.string().optional(),
        })
        .strict(),
      requiredScopes: ["write:notes"],
      handler: (input, ctx) =>
        withTable(deps, ctx, input.vault, input.path, input.table_index, input.prev_hash, (t) => {
          const c = colIndex(t, input.column);
          const dir = input.order === "desc" ? -1 : 1;
          t.rows.sort((a, b) => {
            const av = a[c] ?? "";
            const bv = b[c] ?? "";
            if (input.numeric) return (Number(av) - Number(bv)) * dir;
            return av.localeCompare(bv) * dir;
          });
        }),
    }),
  ];
}
