// Domain 12 — Periodic Notes. Five tools: get_periodic_note, create_periodic_note,
// find_or_create_periodic_note, append_to_periodic_note, list_periodic_notes. Pure
// filesystem: the target path is resolved from the vault's daily/periodic config
// (or Obsidian defaults) by the periodic resolver, then read/written through
// resolveVaultPath + enforcePathAcl like any note. No periodic-notes plugin is
// required, so missing config falls back to defaults rather than erroring. Template
// content (template_override or the configured template) is copied verbatim;
// Templater-style placeholder expansion is out of scope for M3 (no plugin bridge).
import { err, Pagination, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { type FolderAcl, globMatch } from "../../acl";
import {
  formatMoment,
  type Period,
  parseDateInput,
  resolvePeriodicConfig,
  resolvePeriodicPath,
  toISODate,
} from "../../formats/periodic";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { parseNote } from "../../vault/frontmatter";
import { noteExists, readNote, statNote, writeNoteAtomic } from "../../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath } from "../../vault/paths";
import { defineTool } from "../m1/define";
import type { M3Deps } from "./index";

const PeriodEnum = z.enum(["daily", "weekly", "monthly", "quarterly", "yearly"]);

const LIST_WINDOW: Record<Period, number> = {
  daily: 365,
  weekly: 104,
  monthly: 36,
  quarterly: 16,
  yearly: 10,
};
const LIST_MAX_STEPS = 5000;

function readableAcl(acl: FolderAcl | undefined, rel: string): boolean {
  if (!acl || acl.readPaths === undefined) return true;
  return acl.readPaths.some((g) => globMatch(g, rel));
}

function stepDate(date: Date, period: Period, n = 1): Date {
  const d = new Date(date.getTime());
  if (period === "daily") d.setUTCDate(d.getUTCDate() + n);
  else if (period === "weekly") d.setUTCDate(d.getUTCDate() + 7 * n);
  else if (period === "monthly") d.setUTCMonth(d.getUTCMonth() + n);
  else if (period === "quarterly") d.setUTCMonth(d.getUTCMonth() + 3 * n);
  else d.setUTCFullYear(d.getUTCFullYear() + n);
  return d;
}

/** Append content to a note body, optionally under a heading section. */
function appendContent(
  existing: string,
  content: string,
  ensureNewline: boolean,
  heading?: string,
): string {
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  if (heading) {
    const lines = existing.split(/\r?\n/);
    const re = /^(#{1,6})\s+(.*?)\s*$/;
    const want = heading.trim().toLowerCase();
    let hi = -1;
    let level = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i] ?? "");
      if (m && (m[2] ?? "").trim().toLowerCase() === want) {
        hi = i;
        level = (m[1] ?? "").length;
        break;
      }
    }
    if (hi >= 0) {
      let end = lines.length;
      for (let j = hi + 1; j < lines.length; j++) {
        const m = re.exec(lines[j] ?? "");
        if (m && (m[1] ?? "").length <= level) {
          end = j;
          break;
        }
      }
      return [...lines.slice(0, end), ...content.split(/\r?\n/), ...lines.slice(end)].join(eol);
    }
    const sep = existing.length > 0 && !existing.endsWith("\n") ? eol : "";
    return `${existing}${sep}## ${heading}${eol}${content}`;
  }
  const sep = ensureNewline && existing.length > 0 && !existing.endsWith("\n") ? eol : "";
  return existing + sep + content;
}

function loadTemplate(
  root: string,
  acl: FolderAcl | undefined,
  templatePath: string,
): string | null {
  const rel = normalizeVaultPath(templatePath);
  enforcePathAcl(acl, "read", rel);
  const abs = resolveVaultPath(root, rel);
  const ex = noteExists(abs);
  if (!ex.exists || ex.type === "folder") return null;
  return readNote(abs).raw;
}

export function buildPeriodicTools(deps: M3Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "get_periodic_note",
      description:
        "Get the periodic note for a period + date (no creation). Resolves the path from the vault's daily/periodic config or Obsidian defaults.",
      inputSchema: z
        .object({
          vault: VaultId,
          period: PeriodEnum,
          date: z.string().optional(),
          include_content: z.boolean().default(true),
        })
        .strict(),
      requiredScopes: ["read:periodic"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const date = parseDateInput(input.date);
        const { path } = resolvePeriodicPath(v.root, input.period, date);
        enforcePathAcl(ctx.acl, "read", path);
        const abs = resolveVaultPath(v.root, path);
        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          return { period: input.period, date: toISODate(date), path, exists: false };
        const { raw } = readNote(abs);
        const parsed = parseNote(raw);
        return {
          period: input.period,
          date: toISODate(date),
          path,
          exists: true,
          ...(input.include_content ? { content: raw, frontmatter: parsed.frontmatter } : {}),
        };
      },
    }),

    defineTool({
      name: "create_periodic_note",
      description:
        "Create the periodic note for a period + date using the configured (or overridden) template. Fails if it already exists.",
      inputSchema: z
        .object({
          vault: VaultId,
          period: PeriodEnum,
          date: z.string().optional(),
          template_override: VaultPath.optional(),
          idempotency_key: z.string().min(1).max(128).optional(),
        })
        .strict(),
      requiredScopes: ["write:periodic"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const date = parseDateInput(input.date);
        const resolved = resolvePeriodicPath(v.root, input.period, date);
        enforcePathAcl(ctx.acl, "write", resolved.path);
        const abs = resolveVaultPath(v.root, resolved.path);
        if (noteExists(abs).exists)
          throw err.noteExists("periodic note already exists", { path: resolved.path });

        let content = "";
        let templateUsed: string | null = null;
        if (input.template_override) {
          const t = loadTemplate(v.root, ctx.acl, input.template_override);
          if (t === null)
            throw err.invalidInput("template_override not found", {
              path: input.template_override,
            });
          content = t;
          templateUsed = normalizeVaultPath(input.template_override);
        } else if (resolved.template) {
          const t = loadTemplate(v.root, ctx.acl, resolved.template);
          if (t !== null) {
            content = t;
            templateUsed = normalizeVaultPath(resolved.template);
          }
        }
        writeNoteAtomic(abs, content, true);
        return {
          period: input.period,
          date: toISODate(date),
          path: resolved.path,
          created_at: new Date().toISOString(),
          template_used: templateUsed,
        };
      },
    }),

    defineTool({
      name: "find_or_create_periodic_note",
      description:
        "Get the periodic note for a period + date, creating it (empty/template) if absent.",
      inputSchema: z
        .object({
          vault: VaultId,
          period: PeriodEnum,
          date: z.string().optional(),
          include_content: z.boolean().default(true),
        })
        .strict(),
      requiredScopes: ["read:periodic", "write:periodic"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const date = parseDateInput(input.date);
        const resolved = resolvePeriodicPath(v.root, input.period, date);
        const abs = resolveVaultPath(v.root, resolved.path);
        let created = false;
        if (!noteExists(abs).exists) {
          enforcePathAcl(ctx.acl, "write", resolved.path);
          let content = "";
          if (resolved.template) {
            const t = loadTemplate(v.root, ctx.acl, resolved.template);
            if (t !== null) content = t;
          }
          writeNoteAtomic(abs, content, true);
          created = true;
        } else {
          enforcePathAcl(ctx.acl, "read", resolved.path);
        }
        const { raw } = readNote(abs);
        const parsed = parseNote(raw);
        return {
          period: input.period,
          date: toISODate(date),
          path: resolved.path,
          created,
          ...(input.include_content ? { content: raw, frontmatter: parsed.frontmatter } : {}),
        };
      },
    }),

    defineTool({
      name: "append_to_periodic_note",
      description:
        "Append content to a period's note (creating it if needed), optionally under a heading. idempotency_key is accepted (enforcement lands with the policy layer).",
      inputSchema: z
        .object({
          vault: VaultId,
          period: PeriodEnum,
          date: z.string().optional(),
          content: z.string(),
          ensure_newline: z.boolean().default(true),
          heading: z.string().min(1).optional(),
          idempotency_key: z.string().min(1).max(128).optional(),
        })
        .strict(),
      requiredScopes: ["write:periodic"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const date = parseDateInput(input.date);
        const resolved = resolvePeriodicPath(v.root, input.period, date);
        enforcePathAcl(ctx.acl, "write", resolved.path);
        const abs = resolveVaultPath(v.root, resolved.path);
        const ex = noteExists(abs);
        if (ex.exists && ex.type === "folder")
          throw err.invalidInput("path is a folder", { path: resolved.path });
        const existing = ex.exists ? readNote(abs).raw : "";
        const next = appendContent(existing, input.content, input.ensure_newline, input.heading);
        writeNoteAtomic(abs, next, true);
        return {
          period: input.period,
          date: toISODate(date),
          path: resolved.path,
          updated_at: new Date().toISOString(),
          appended_bytes: Buffer.byteLength(next, "utf8") - Buffer.byteLength(existing, "utf8"),
          created: !ex.exists,
        };
      },
    }),

    defineTool({
      name: "list_periodic_notes",
      description:
        "Enumerate existing periodic notes in a date range (probes the configured format/folder). Defaults to a recent window when from/to are omitted.",
      inputSchema: z
        .object({
          vault: VaultId,
          period: PeriodEnum,
          from: z.string().optional(),
          to: z.string().optional(),
        })
        .merge(Pagination)
        .strict(),
      requiredScopes: ["read:periodic"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const to = input.to ? parseDateInput(input.to) : parseDateInput();
        const from = input.from
          ? parseDateInput(input.from)
          : stepDate(to, input.period, -LIST_WINDOW[input.period]);
        if (from.getTime() > to.getTime())
          throw err.invalidInput("from must be on or before to", {
            from: toISODate(from),
            to: toISODate(to),
          });
        const { config } = resolvePeriodicConfig(v.root, input.period);
        const folder = config.folder ? normalizeVaultPath(config.folder) : "";

        const found: Array<{ period: Period; date: string; path: string; mtime: string }> = [];
        let steps = 0;
        let overflow = false;
        for (let d = from; d.getTime() <= to.getTime(); d = stepDate(d, input.period)) {
          if (steps++ >= LIST_MAX_STEPS) {
            overflow = true;
            break;
          }
          const name = formatMoment(d, config.format);
          const rel = `${folder ? `${folder}/` : ""}${name}.md`;
          if (!readableAcl(ctx.acl, rel)) continue;
          const st = statNote(resolveVaultPath(v.root, rel));
          if (st)
            found.push({ period: input.period, date: toISODate(d), path: rel, mtime: st.mtime });
        }

        const limit = input.limit ?? 100;
        const start = input.cursor ? Math.max(0, Number.parseInt(input.cursor, 10) || 0) : 0;
        const page = found.slice(start, start + limit);
        const nextStart = start + page.length;
        const next = nextStart < found.length ? String(nextStart) : undefined;
        return {
          vault: v.id,
          period: input.period,
          total: found.length,
          items: page,
          ...(overflow ? { overflow: true } : {}),
          ...(next ? { next_cursor: next } : {}),
        };
      },
    }),
  ];
}
