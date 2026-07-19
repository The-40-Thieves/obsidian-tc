// Domain — Kanban boards (THE-379). Pure-filesystem: the Kanban plugin stores each board as a
// markdown file (frontmatter `kanban-plugin: board`; H2 headings = columns; `- [ ]` list items =
// cards; a trailing `%% kanban:settings %%` block). read/list/add-card/move-card operate on the
// markdown directly, preserving frontmatter + the settings block, so this works headlessly (no
// plugin) and an agent moves/adds cards without breaking the plugin's parsing conventions.
import { err, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { readableRel } from "../../vault/acl-read-filter";
import { parseNote, serializeNote } from "../../vault/frontmatter";
import { noteExists, readNote, writeNoteAtomic } from "../../vault/notes-io";
import { contentHash, normalizeVaultPath, resolveVaultPath, walkVault } from "../../vault/paths";
import { defineTool } from "../m1/define";
import type { M3Deps } from "./index";

function isBoard(fm: Record<string, unknown> | null): boolean {
  return !!fm && fm["kanban-plugin"] === "board";
}

const H2 = /^##\s+(.+?)\s*$/;
const CARD = /^\s*-\s+(?:\[([ xX])\]\s+)?(.*)$/;

interface Card {
  text: string;
  checked: boolean;
  line: number;
}
interface Column {
  name: string;
  headingLine: number;
  cards: Card[];
}

function parseBoard(body: string): { lines: string[]; columns: Column[] } {
  const lines = body.split(/\r?\n/);
  let settingsStart = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").trim().startsWith("%% kanban:settings")) {
      settingsStart = i;
      break;
    }
  }
  const columns: Column[] = [];
  let cur: Column | null = null;
  for (let i = 0; i < settingsStart; i++) {
    const line = lines[i] ?? "";
    const hm = H2.exec(line);
    if (hm) {
      cur = { name: (hm[1] ?? "").trim(), headingLine: i, cards: [] };
      columns.push(cur);
      continue;
    }
    if (cur && line.trim() !== "") {
      const cm = CARD.exec(line);
      if (cm && cm[2] !== undefined)
        cur.cards.push({
          text: cm[2].trim(),
          checked: (cm[1] ?? " ").toLowerCase() === "x",
          line: i,
        });
    }
  }
  return { lines, columns };
}

function findColumn(columns: Column[], name: string): Column | undefined {
  const want = name.trim().toLowerCase();
  return columns.find((c) => c.name.toLowerCase() === want);
}

/** Line index at which to insert a new card into a column (after its last card, else after its
 *  heading). */
function insertLine(col: Column): number {
  return col.cards.length
    ? (col.cards[col.cards.length - 1]?.line ?? col.headingLine) + 1
    : col.headingLine + 1;
}

export function buildKanbanTools(deps: M3Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "list_kanban_boards",
      description:
        "List Kanban board notes in the vault (frontmatter kanban-plugin: board), with column and card counts.",
      inputSchema: z.object({ vault: VaultId, folder: VaultPath.optional() }).strict(),
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const sub = input.folder ? normalizeVaultPath(input.folder) : undefined;
        const boards: Array<{ path: string; columns: number; cards: number }> = [];
        for (const e of walkVault(v.root, { sub, extensions: [".md"] })) {
          if (!readableRel(ctx.acl, e.relPath)) continue;
          const parsed = parseNote(readNote(resolveVaultPath(v.root, e.relPath)).raw);
          if (!isBoard(parsed.frontmatter)) continue;
          const { columns } = parseBoard(parsed.body);
          boards.push({
            path: e.relPath,
            columns: columns.length,
            cards: columns.reduce((n, c) => n + c.cards.length, 0),
          });
        }
        return { vault: v.id, total: boards.length, boards };
      },
    }),

    defineTool({
      name: "read_kanban_board",
      pathAcl: (input) => [{ op: "read", path: input.path }],
      description: "Parse a Kanban board note into its columns and cards (text + checked state).",
      inputSchema: z.object({ vault: VaultId, path: VaultPath }).strict(),
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "read", rel, v.root);
        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("note not found", { path: rel });
        const { raw, hash } = readNote(abs);
        const parsed = parseNote(raw);
        if (!isBoard(parsed.frontmatter))
          throw err.invalidInput("not a Kanban board (missing kanban-plugin: board)", {
            path: rel,
          });
        const { columns } = parseBoard(parsed.body);
        return {
          vault: v.id,
          path: rel,
          content_hash: hash,
          columns: columns.map((c) => ({
            name: c.name,
            cards: c.cards.map((cd) => ({ text: cd.text, checked: cd.checked })),
          })),
        };
      },
    }),

    defineTool({
      name: "add_kanban_card",
      pathAcl: (input) => [{ op: "write", path: input.path }],
      description:
        "Add a card to a Kanban column (by name). Appends `- [ ] text` (or `- [x]` when checked) under the column heading, preserving the rest of the board.",
      inputSchema: z
        .object({
          vault: VaultId,
          path: VaultPath,
          column: z.string().min(1),
          text: z.string().min(1),
          checked: z.boolean().default(false),
          prev_hash: z.string().optional(),
        })
        .strict(),
      requiredScopes: ["write:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "write", rel, v.root);
        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("note not found", { path: rel });
        const { raw, hash } = readNote(abs);
        if (input.prev_hash !== undefined && input.prev_hash !== hash)
          throw err.concurrentModification("board changed since prev_hash", {
            path: rel,
            expected: input.prev_hash,
            actual: hash,
          });
        const parsed = parseNote(raw);
        if (!isBoard(parsed.frontmatter))
          throw err.invalidInput("not a Kanban board (missing kanban-plugin: board)", {
            path: rel,
          });
        const eol = raw.includes("\r\n") ? "\r\n" : "\n";
        const { lines, columns } = parseBoard(parsed.body);
        const col = findColumn(columns, input.column);
        if (!col) throw err.invalidInput("column not found", { column: input.column });
        const card = `- [${input.checked ? "x" : " "}] ${input.text}`;
        const at = insertLine(col);
        const nextBody = [...lines.slice(0, at), card, ...lines.slice(at)].join(eol);
        const next = serializeNote(parsed.frontmatter, nextBody, parsed.rawFrontmatter);
        writeNoteAtomic(abs, next, false);
        deps.reindex?.(v.id, rel, next);
        return {
          vault: v.id,
          path: rel,
          column: col.name,
          added: input.text,
          content_hash: contentHash(next),
          prev_hash: hash,
        };
      },
    }),

    defineTool({
      name: "move_kanban_card",
      pathAcl: (input) => [{ op: "write", path: input.path }],
      description:
        "Move a card (matched by text) from one Kanban column to another, preserving its original line (checkbox state, inline metadata).",
      inputSchema: z
        .object({
          vault: VaultId,
          path: VaultPath,
          from_column: z.string().min(1),
          to_column: z.string().min(1),
          card_text: z.string().min(1),
          prev_hash: z.string().optional(),
        })
        .strict(),
      requiredScopes: ["write:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "write", rel, v.root);
        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("note not found", { path: rel });
        const { raw, hash } = readNote(abs);
        if (input.prev_hash !== undefined && input.prev_hash !== hash)
          throw err.concurrentModification("board changed since prev_hash", {
            path: rel,
            expected: input.prev_hash,
            actual: hash,
          });
        const parsed = parseNote(raw);
        if (!isBoard(parsed.frontmatter))
          throw err.invalidInput("not a Kanban board (missing kanban-plugin: board)", {
            path: rel,
          });
        const eol = raw.includes("\r\n") ? "\r\n" : "\n";
        const p1 = parseBoard(parsed.body);
        const from = findColumn(p1.columns, input.from_column);
        if (!from) throw err.invalidInput("from_column not found", { column: input.from_column });
        const want = input.card_text.trim().toLowerCase();
        const card = from.cards.find((c) => c.text.toLowerCase() === want);
        if (!card)
          throw err.invalidInput("card not found in from_column", { card_text: input.card_text });
        const cardLine = p1.lines[card.line] ?? `- [ ] ${input.card_text}`;
        // Remove the source line, then re-parse so target line indices are correct.
        const removed = [...p1.lines.slice(0, card.line), ...p1.lines.slice(card.line + 1)];
        const p2 = parseBoard(removed.join(eol));
        const to = findColumn(p2.columns, input.to_column);
        if (!to) throw err.invalidInput("to_column not found", { column: input.to_column });
        const at = insertLine(to);
        const nextBody = [...removed.slice(0, at), cardLine, ...removed.slice(at)].join(eol);
        const next = serializeNote(parsed.frontmatter, nextBody, parsed.rawFrontmatter);
        writeNoteAtomic(abs, next, false);
        deps.reindex?.(v.id, rel, next);
        return {
          vault: v.id,
          path: rel,
          moved: card.text,
          from: from.name,
          to: to.name,
          content_hash: contentHash(next),
          prev_hash: hash,
        };
      },
    }),
  ];
}
