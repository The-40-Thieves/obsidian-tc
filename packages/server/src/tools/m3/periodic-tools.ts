// Domain 12 — Periodic Notes. Five tools: get_periodic_note, create_periodic_note,
// find_or_create_periodic_note, append_to_periodic_note, list_periodic_notes. Pure
// filesystem: the target path is resolved from the vault's daily/periodic config
// (or Obsidian defaults) by the periodic resolver, then read/written through
// resolveVaultPath + enforcePathAcl like any note. No periodic-notes plugin is
// required, so missing config falls back to defaults rather than erroring. Template
// content (template_override or the configured template) is copied verbatim by default;
// with expand_template=true it is expanded through the Templater bridge (THE-207) when the
// companion + Templater are present, degrading to a verbatim copy otherwise.
import {
  err,
  grantsAll,
  ObsidianTcError,
  Pagination,
  VaultId,
  VaultPath,
} from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { FolderAcl } from "../../acl";
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
import { readableRel } from "../../vault/acl-read-filter";
import { parseNote } from "../../vault/frontmatter";
import { noteExists, readNote, statNote, writeNoteAtomic } from "../../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath } from "../../vault/paths";
import { defineTool } from "../m1/define";
import type { M3Deps } from "./shared";

const PeriodEnum = z.enum(["daily", "weekly", "monthly", "quarterly", "yearly"]);

const LIST_WINDOW: Record<Period, number> = {
  daily: 365,
  weekly: 104,
  monthly: 36,
  quarterly: 16,
  yearly: 10,
};
const LIST_MAX_STEPS = 5000;

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
  // THE-567: threaded through so a rule-scoped template folder is enforced here too, not just the
  // folder allowlist. Harmless to pass even when the caller (create_periodic_note) also declares a
  // pathAcl extractor for this same path — the central stage already checked it with the identical
  // acl/path/grantedScopes, so this handler-side recheck can only reach the same decision.
  grantedScopes?: Iterable<string>,
): string | null {
  const rel = normalizeVaultPath(templatePath);
  enforcePathAcl(acl, "read", rel, root, grantedScopes);
  const abs = resolveVaultPath(root, rel);
  const ex = noteExists(abs);
  if (!ex.exists || ex.type === "folder") return null;
  return readNote(abs).raw;
}

// THE-207: Templater degrade taxonomy — a missing/unreachable companion or plugin means
// "expansion unavailable", so creation falls back to a verbatim copy rather than failing.
const TEMPLATER_DEGRADE = new Set([
  "plugin_missing",
  "plugin_unreachable",
  "requires_live_obsidian",
]);

/**
 * Expand `template` into `target` via the Templater bridge, which writes the expanded note
 * itself. Returns true when the bridge wrote it, false when no bridge is wired or the
 * companion/Templater is unavailable (caller then falls back to a verbatim copy). A genuine
 * execution error (e.g. a broken template) propagates rather than silently degrading.
 */
async function expandViaTemplater(
  deps: M3Deps,
  vaultId: string,
  template: string,
  target: string,
): Promise<boolean> {
  if (!deps.templaterBridge) return false;
  try {
    const { client, timeoutMs } = deps.templaterBridge(vaultId);
    await client.request<unknown>({
      method: "POST",
      path: "/templater/execute",
      body: { template, target, overwrite: false },
      plugin: "templater",
      timeoutMs,
    });
    return true;
  } catch (e) {
    if (e instanceof ObsidianTcError && TEMPLATER_DEGRADE.has(e.code)) return false;
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// THE-417 Phase 1: declared output contracts, written from the RETURN STATEMENTS below.
//
// get_periodic_note and find_or_create_periodic_note share the same `content`/`frontmatter`
// shape: a conditional spread on `include_content`, so both fields are optional together, never
// nullable — the key is simply absent when content was not requested. `frontmatter` is
// parseNote()'s own Frontmatter type, which IS nullable (no frontmatter block at all).
// ---------------------------------------------------------------------------------------------

const PeriodicContentFields = {
  content: z.string().optional(),
  frontmatter: z.record(z.string(), z.unknown()).nullable().optional(),
};

/** get_periodic_note has an early return (note absent, `exists: false`, no content fields at
 *  all) and a later one (`exists: true` plus the conditional content fields above). One object
 *  with optionals covers both arms rather than a union, matching every other m3/m7/m8 "optional
 *  fields on a conditional path" contract in this ticket. */
const GetPeriodicNoteOutput = z.object({
  period: PeriodEnum,
  date: z.string(),
  path: z.string(),
  exists: z.boolean(),
  ...PeriodicContentFields,
});

const CreatePeriodicNoteOutput = z.object({
  period: PeriodEnum,
  date: z.string(),
  path: z.string(),
  created_at: z.string(),
  template_used: z.string().nullable(),
  template_expanded: z.boolean(),
});

const FindOrCreatePeriodicNoteOutput = z.object({
  period: PeriodEnum,
  date: z.string(),
  path: z.string(),
  created: z.boolean(),
  ...PeriodicContentFields,
});

const AppendToPeriodicNoteOutput = z.object({
  period: PeriodEnum,
  date: z.string(),
  path: z.string(),
  updated_at: z.string(),
  appended_bytes: z.number().int(),
  created: z.boolean(),
});

const ListPeriodicNotesOutput = z.object({
  vault: z.string(),
  period: PeriodEnum,
  total: z.number().int(),
  items: z.array(
    z.object({
      period: PeriodEnum,
      date: z.string(),
      path: z.string(),
      // statNote's mtime — an ISO-string, NOT the WalkEntry epoch-millis mtime used in
      // attachment-tools.ts's list_attachments; the two helpers disagree on representation.
      mtime: z.string(),
    }),
  ),
  // Present only when the scan hit LIST_MAX_STEPS before reaching `to`.
  overflow: z.literal(true).optional(),
  next_cursor: z.string().optional(),
});

export function buildPeriodicTools(deps: M3Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "get_periodic_note",
      domain: "workspace",
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
      outputSchema: GetPeriodicNoteOutput,
      requiredScopes: ["read:periodic"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const date = parseDateInput(input.date);
        const { path } = resolvePeriodicPath(v.root, input.period, date);
        enforcePathAcl(ctx.acl, "read", path, v.root);
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
      domain: "workspace",
      vaultArg: "vault",
      acceptsIdempotencyKey: true,
      description:
        "Create the periodic note for a period + date using the configured (or overridden) template. Fails if it already exists. Set expand_template=true to expand the template through Templater (requires write:templater; degrades to a verbatim copy when the companion/plugin is unavailable).",
      inputSchema: z
        .object({
          vault: VaultId,
          period: PeriodEnum,
          date: z.string().optional(),
          template_override: VaultPath.optional(),
          expand_template: z.boolean().default(false),
          idempotency_key: z.string().min(1).max(128).optional(),
        })
        .strict(),
      requiredScopes: ["write:periodic"],
      // THE-567: template_override is the one path this tool touches that arrives verbatim in
      // input, so it can be declared for the central runDispatch pathAcl stage (folder + P1.4
      // rule-scope). The actual note-creation TARGET path is resolver({period,date}) under the
      // periodic-notes config — not input-derivable — so it stays handler-side (see below).
      pathAcl: (input) =>
        input.template_override ? [{ op: "read" as const, path: input.template_override }] : [],
      outputSchema: CreatePeriodicNoteOutput,
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const date = parseDateInput(input.date);
        const resolved = resolvePeriodicPath(v.root, input.period, date);
        enforcePathAcl(ctx.acl, "write", resolved.path, v.root, ctx.grantedScopes);
        const abs = resolveVaultPath(v.root, resolved.path);
        if (noteExists(abs).exists)
          throw err.noteExists("periodic note already exists", { path: resolved.path });

        let content = "";
        let templateUsed: string | null = null;
        if (input.template_override) {
          const t = loadTemplate(v.root, ctx.acl, input.template_override, ctx.grantedScopes);
          if (t === null)
            throw err.invalidInput("template_override not found", {
              path: input.template_override,
            });
          content = t;
          templateUsed = normalizeVaultPath(input.template_override);
        } else if (resolved.template) {
          const t = loadTemplate(v.root, ctx.acl, resolved.template, ctx.grantedScopes);
          if (t !== null) {
            content = t;
            templateUsed = normalizeVaultPath(resolved.template);
          }
        }
        // THE-207: optionally expand via Templater (which writes the note itself). Gated on
        // write:templater; degrades to a verbatim copy when the bridge/plugin is unavailable.
        let expanded = false;
        if (input.expand_template && templateUsed) {
          if (!grantsAll(ctx.grantedScopes, ["write:templater"]))
            throw new ObsidianTcError(
              "forbidden",
              "expand_template requires the write:templater scope",
              { required: ["write:templater"] },
            );
          // THE-572: Templater writes the note itself, so this call IS the first durable effect.
          ctx.markEffectCommitted?.();
          expanded = await expandViaTemplater(deps, v.id, templateUsed, resolved.path);
        }
        if (!expanded) {
          // THE-572: the note write is self-protected against a double-write by the noteExists
          // refusal above, but a retry after a fallible `deps.reindex` throw would answer
          // `note_exists` — telling the caller someone ELSE holds the path, when in fact their own
          // prior attempt created it. Marking here makes that retry the accurate
          // `indeterminate_outcome` instead.
          ctx.markEffectCommitted?.();
          writeNoteAtomic(abs, content, true);
          deps.reindex?.(v.id, resolved.path, content);
        }
        return {
          period: input.period,
          date: toISODate(date),
          path: resolved.path,
          created_at: new Date().toISOString(),
          template_used: templateUsed,
          template_expanded: expanded,
        };
      },
    }),

    defineTool({
      name: "find_or_create_periodic_note",
      domain: "workspace",
      vaultArg: "vault",
      description:
        "Get the periodic note for a period + date, creating it (empty/template) if absent. With expand_template=true a newly created note is expanded through Templater when available (requires write:templater).",
      inputSchema: z
        .object({
          vault: VaultId,
          period: PeriodEnum,
          date: z.string().optional(),
          include_content: z.boolean().default(true),
          expand_template: z.boolean().default(false),
        })
        .strict(),
      outputSchema: FindOrCreatePeriodicNoteOutput,
      requiredScopes: ["read:periodic", "write:periodic"],
      handler: async (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const date = parseDateInput(input.date);
        const resolved = resolvePeriodicPath(v.root, input.period, date);
        const abs = resolveVaultPath(v.root, resolved.path);
        let created = false;
        if (!noteExists(abs).exists) {
          enforcePathAcl(ctx.acl, "write", resolved.path, v.root, ctx.grantedScopes);
          let content = "";
          let templateUsed: string | null = null;
          if (resolved.template) {
            const t = loadTemplate(v.root, ctx.acl, resolved.template, ctx.grantedScopes);
            if (t !== null) {
              content = t;
              templateUsed = normalizeVaultPath(resolved.template);
            }
          }
          // THE-207: expand via Templater when requested + available; else verbatim copy.
          let expanded = false;
          if (input.expand_template && templateUsed) {
            if (!grantsAll(ctx.grantedScopes, ["write:templater"]))
              throw new ObsidianTcError(
                "forbidden",
                "expand_template requires the write:templater scope",
                { required: ["write:templater"] },
              );
            expanded = await expandViaTemplater(deps, v.id, templateUsed, resolved.path);
          }
          if (!expanded) {
            writeNoteAtomic(abs, content, true);
            deps.reindex?.(v.id, resolved.path, content);
          }
          created = true;
        } else {
          enforcePathAcl(ctx.acl, "read", resolved.path, v.root, ctx.grantedScopes);
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
      domain: "workspace",
      vaultArg: "vault",
      acceptsIdempotencyKey: true,
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
      outputSchema: AppendToPeriodicNoteOutput,
      requiredScopes: ["write:periodic"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const date = parseDateInput(input.date);
        const resolved = resolvePeriodicPath(v.root, input.period, date);
        enforcePathAcl(ctx.acl, "write", resolved.path, v.root, ctx.grantedScopes);
        const abs = resolveVaultPath(v.root, resolved.path);
        const ex = noteExists(abs);
        if (ex.exists && ex.type === "folder")
          throw err.invalidInput("path is a folder", { path: resolved.path });
        const existing = ex.exists ? readNote(abs).raw : "";
        const next = appendContent(existing, input.content, input.ensure_newline, input.heading);
        // THE-572: appending is the one effect here that CANNOT be made idempotent — re-running it
        // appends the content a second time — and `deps.reindex` below is fallible (the index
        // coordinator rejects under backpressure). Without this signal a reindex throw deleted the
        // claim and a retry duplicated the appended block. Marked write-ahead, so the worst case is
        // a caller told to verify state when the write never landed, never a silent double-append.
        ctx.markEffectCommitted?.();
        writeNoteAtomic(abs, next, true);
        deps.reindex?.(v.id, resolved.path, next);
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
      domain: "workspace",
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
      outputSchema: ListPeriodicNotesOutput,
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
          if (!readableRel(ctx.acl, rel)) continue;
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
