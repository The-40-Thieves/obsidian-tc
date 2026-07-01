// Domain 4 — Tags (G2.1 r2). Five tools: list_tags, get_note_tags, add_tag,
// remove_tag, find_notes_by_tag. Tags are read from both the frontmatter
// `tags`/`tag` keys and inline `#hashtags` (see vault/tags.ts), and are
// hierarchical — a query for `project` matches `project` and `project/sub`.
// add_tag/remove_tag are content-addressed (prev_hash CAS); writes target the
// frontmatter `tags` list or the body, per the `location` argument.
import { err, VaultId, VaultPath } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { type FolderAcl, globMatch } from "../../acl";
import type { ToolDefinition } from "../../mcp/registry";
import { enforcePathAcl } from "../../vault/acl-path";
import { type Frontmatter, parseNote, serializeNote } from "../../vault/frontmatter";
import { noteExists, readNote, writeNoteAtomic } from "../../vault/notes-io";
import { contentHash, normalizeVaultPath, resolveVaultPath, walkVault } from "../../vault/paths";
import {
  extractInlineTags,
  isValidTag,
  normalizeTag,
  noteTags,
  tagMatches,
} from "../../vault/tags";
import { defineTool } from "./define";
import type { M1Deps } from "./index";

// ── helpers ──────────────────────────────────────────────────────────────────

function readable(acl: FolderAcl | undefined, rel: string): boolean {
  if (!acl) return true;
  const list = acl.readPaths;
  if (list === undefined) return true;
  return list.some((g) => globMatch(g, rel));
}

/** Normalize a frontmatter `tags` field value (list or string) to a tag list. */
function fieldTags(val: unknown): string[] {
  const out: string[] = [];
  if (typeof val === "string")
    for (const p of val.split(/[,\s]+/)) {
      const t = normalizeTag(p);
      if (t) out.push(t);
    }
  else if (Array.isArray(val))
    for (const e of val)
      if (typeof e === "string") {
        const t = normalizeTag(e);
        if (t) out.push(t);
      }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Return a copy of `obj` without `key` (avoids the `delete` operator). */
function omitKey(obj: Frontmatter, key: string): Frontmatter {
  const out: Frontmatter = {};
  for (const k of Object.keys(obj)) if (k !== key) out[k] = obj[k];
  return out;
}

// ── schemas ──────────────────────────────────────────────────────────────────

const AddInput = z
  .object({
    vault: VaultId,
    path: VaultPath,
    tag: z.string().min(1),
    location: z.enum(["frontmatter", "inline"]).default("frontmatter"),
    prev_hash: z.string().optional(),
  })
  .strict();

const RemoveInput = z
  .object({
    vault: VaultId,
    path: VaultPath,
    tag: z.string().min(1),
    location: z.enum(["frontmatter", "inline", "all"]).default("all"),
    prev_hash: z.string().optional(),
  })
  .strict();

const ListInput = z
  .object({
    vault: VaultId,
    folder: VaultPath.optional(),
    max_notes: z.number().int().positive().max(50000).default(5000),
  })
  .strict();

const FindInput = z
  .object({
    vault: VaultId,
    tag: z.string().min(1),
    folder: VaultPath.optional(),
    limit: z.number().int().positive().max(1000).default(200),
  })
  .strict();

// ── tools ────────────────────────────────────────────────────────────────────

export function buildTagsTools(deps: M1Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "list_tags",
      description: "Aggregate all tags (frontmatter + inline) across notes, with usage counts.",
      inputSchema: ListInput,
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const sub = input.folder ? normalizeVaultPath(input.folder) : undefined;
        const entries = walkVault(v.root, { sub, extensions: [".md"] }).filter((e) =>
          readable(ctx.acl, e.relPath),
        );
        const counts = new Map<string, number>();
        let scanned = 0;
        for (const e of entries) {
          if (scanned >= input.max_notes) break;
          scanned++;
          for (const t of noteTags(readNote(resolveVaultPath(v.root, e.relPath)).raw).all)
            counts.set(t, (counts.get(t) ?? 0) + 1);
        }
        const tags = [...counts.entries()]
          .map(([tag, count]) => ({ tag, count }))
          .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
        return { vault: v.id, notes_scanned: scanned, tags };
      },
    }),

    defineTool({
      name: "get_note_tags",
      description: "Get a note's tags, split into frontmatter, inline, and the combined set.",
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
        const t = noteTags(readNote(abs).raw);
        return { vault: v.id, path: rel, ...t };
      },
    }),

    defineTool({
      name: "add_tag",
      description:
        "Add a tag to a note's frontmatter `tags` list or inline in the body (idempotent).",
      inputSchema: AddInput,
      requiredScopes: ["write:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "write", rel, v.root);
        const tag = normalizeTag(input.tag);
        if (!isValidTag(tag)) throw err.invalidInput("invalid tag", { tag: input.tag });

        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("note not found", { path: rel });
        const { raw, hash } = readNote(abs);
        if (input.prev_hash !== undefined && input.prev_hash !== hash)
          throw err.concurrentModification("note changed since prev_hash", {
            path: rel,
            expected: input.prev_hash,
            actual: hash,
          });

        const parsed = parseNote(raw);
        let fm: Frontmatter | null = parsed.frontmatter;
        let body = parsed.body;
        let added = false;
        if (input.location === "frontmatter") {
          const cur = { ...(parsed.frontmatter ?? {}) };
          const list = fieldTags(cur.tags);
          if (!list.includes(tag)) {
            cur.tags = [...list, tag];
            added = true;
          } else {
            cur.tags = list;
          }
          fm = cur;
        } else if (!extractInlineTags(body).includes(tag)) {
          const sep = body.length > 0 && !body.endsWith("\n") ? "\n" : "";
          body = `${body}${sep}#${tag}`;
          added = true;
        }

        const content = serializeNote(fm, body, parsed.rawFrontmatter);
        writeNoteAtomic(abs, content, false);
        return {
          vault: v.id,
          path: rel,
          tag,
          location: input.location,
          added,
          content_hash: contentHash(content),
          prev_hash: hash,
        };
      },
    }),

    defineTool({
      name: "remove_tag",
      description:
        "Remove a tag from a note's frontmatter, its body, or both (exact, not hierarchical).",
      inputSchema: RemoveInput,
      requiredScopes: ["write:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "write", rel, v.root);
        const tag = normalizeTag(input.tag);
        if (!isValidTag(tag)) throw err.invalidInput("invalid tag", { tag: input.tag });

        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("note not found", { path: rel });
        const { raw, hash } = readNote(abs);
        if (input.prev_hash !== undefined && input.prev_hash !== hash)
          throw err.concurrentModification("note changed since prev_hash", {
            path: rel,
            expected: input.prev_hash,
            actual: hash,
          });

        const parsed = parseNote(raw);
        let fm: Frontmatter = { ...(parsed.frontmatter ?? {}) };
        let body = parsed.body;
        let removed = 0;
        if (input.location !== "inline") {
          // Readers (frontmatterTags) consume BOTH the plural `tags` and singular `tag`
          // keys, so remove from both — otherwise a tag under `tag:` is reported by
          // get_note_tags yet silently survives removal (F1).
          for (const key of ["tags", "tag"] as const) {
            if (fm[key] === undefined) continue;
            const list = fieldTags(fm[key]);
            const kept = list.filter((t) => t !== tag);
            if (kept.length !== list.length) {
              removed += list.length - kept.length;
              if (kept.length === 0) fm = omitKey(fm, key);
              else fm[key] = kept;
            }
          }
        }
        if (input.location !== "frontmatter") {
          const re = new RegExp(`(^|\\s)#${escapeRe(tag)}(?![A-Za-z0-9_/-])`, "g");
          body = body.replace(re, (_m, b: string) => {
            removed++;
            return b;
          });
        }

        const nextFm = Object.keys(fm).length > 0 ? fm : null;
        const content = serializeNote(nextFm, body, parsed.rawFrontmatter);
        // Skip the rewrite (and content-hash churn) when nothing was removed (F1).
        if (removed > 0) writeNoteAtomic(abs, content, false);
        return {
          vault: v.id,
          path: rel,
          tag,
          location: input.location,
          removed,
          content_hash: removed > 0 ? contentHash(content) : hash,
          prev_hash: hash,
        };
      },
    }),

    defineTool({
      name: "find_notes_by_tag",
      description:
        "Find notes carrying a tag, hierarchically (a query for `project` matches `project` and `project/sub`).",
      inputSchema: FindInput,
      requiredScopes: ["read:notes"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const sub = input.folder ? normalizeVaultPath(input.folder) : undefined;
        const entries = walkVault(v.root, { sub, extensions: [".md"] }).filter((e) =>
          readable(ctx.acl, e.relPath),
        );
        const matches: Array<{ path: string; tags: string[] }> = [];
        let truncated = false;
        for (const e of entries) {
          const all = noteTags(readNote(resolveVaultPath(v.root, e.relPath)).raw).all;
          const hit = all.filter((t) => tagMatches(input.tag, t));
          if (hit.length === 0) continue;
          if (matches.length >= input.limit) {
            truncated = true;
            break;
          }
          matches.push({ path: e.relPath, tags: hit });
        }
        return {
          vault: v.id,
          tag: normalizeTag(input.tag),
          total: matches.length,
          truncated,
          matches,
        };
      },
    }),
  ];
}
