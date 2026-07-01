// Domain 7 — Bases (.base). Four tools: read_base, create_base, update_base,
// query_base. Round-trip safe: parse/serialize go through the YAML codec and writes
// mutate the parsed mapping in place, so unknown keys (real Obsidian `filters`,
// `properties`, per-view `order`/`limit`, ...) survive. Confirmation is conditional:
// overwriting an existing base and changing a base's `source` (which can invalidate
// every view) require a HITL elicit token. query_base interprets the format: a
// view's `filters` (and any `override_filters`) are JSONLogic over each note's
// { ...frontmatter, path, name, tags, content }; `formulas` whose value is a
// JSONLogic object are computed per row and added as columns. Non-object filters
// (e.g. a real Bases filter string) match all rows — documented, no silent failure.
import {
  err,
  Pagination,
  VaultId,
  VaultPath,
  WriteOptions,
} from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { type FolderAcl, globMatch } from "../../acl";
import { BaseDoc, baseViews, parseBase, selectView, serializeBase } from "../../formats/base";
import type { ToolDefinition } from "../../mcp/registry";
import { applyLogic, evaluatesTruthy } from "../../search/jsonlogic";
import { enforcePathAcl } from "../../vault/acl-path";
import { parseNote } from "../../vault/frontmatter";
import { requireConfirmation } from "../../vault/hitl";
import { buildVaultIndex, extractLinks, resolveTarget } from "../../vault/links";
import { noteExists, readNote, writeNoteAtomic } from "../../vault/notes-io";
import { contentHash, normalizeVaultPath, resolveVaultPath, walkVault } from "../../vault/paths";
import { defineTool } from "../m1/define";
import type { M3Deps } from "./index";

function requireBaseExt(rel: string): void {
  if (!rel.toLowerCase().endsWith(".base"))
    throw err.invalidInput("path must be a .base file", { path: rel });
}

function readableAcl(acl: FolderAcl | undefined, rel: string): boolean {
  if (!acl || acl.readPaths === undefined) return true;
  return acl.readPaths.some((g) => globMatch(g, rel));
}

function baseName(p: string): string {
  const b = p.includes("/") ? p.slice(p.lastIndexOf("/") + 1) : p;
  return b.replace(/\.md$/i, "");
}

function normTags(fm: Record<string, unknown>): string[] {
  const t = fm.tags ?? fm.tag;
  if (t == null) return [];
  const arr = Array.isArray(t) ? t : [t];
  return arr.map((x) => String(x).replace(/^#/, ""));
}

function colValue(col: string, path: string, fm: Record<string, unknown>): unknown {
  if (col === "file.name" || col === "name") return baseName(path);
  if (col === "file.path" || col === "path") return path;
  return fm[col] ?? null;
}

function isLogicObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

const CreateInput = z
  .object({
    vault: VaultId,
    path: VaultPath,
    base: z.record(z.string(), z.unknown()),
    overwrite: z.boolean().default(false),
    options: WriteOptions.prefault({}),
  })
  .strict();

const UpdateInput = z
  .object({
    vault: VaultId,
    path: VaultPath,
    patch: z
      .object({
        source: z.unknown().optional(),
        add_views: z.array(z.record(z.string(), z.unknown())).optional(),
        remove_views: z.array(z.string()).optional(),
        update_views: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
        formulas: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
    prev_hash: z.string().optional(),
  })
  .strict();

const QueryInput = z
  .object({
    vault: VaultId,
    path: VaultPath,
    view: z.string().optional(),
    override_filters: z.record(z.string(), z.unknown()).optional(),
  })
  .merge(Pagination)
  .strict();

export function buildBaseTools(deps: M3Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "read_base",
      description: "Read a .base file's structure (source, views, formulas).",
      inputSchema: z.object({ vault: VaultId, path: VaultPath }).strict(),
      requiredScopes: ["read:bases"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        requireBaseExt(rel);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "read", rel, v.root);
        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("base not found", { path: rel });
        const { raw, hash } = readNote(abs);
        const parsed = parseBase(raw);
        return { vault: v.id, path: rel, base: parsed.raw, content_hash: hash };
      },
    }),

    defineTool({
      name: "create_base",
      description:
        "Create a new .base file from a base definition. Overwriting an existing base requires confirmation.",
      inputSchema: CreateInput,
      requiredScopes: ["write:bases"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        requireBaseExt(rel);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "write", rel, v.root);
        const ex = noteExists(abs);
        if (ex.exists && ex.type === "folder")
          throw err.invalidInput("path is a folder", { path: rel });
        if (ex.exists && !input.overwrite)
          throw err.noteExists("base already exists; set overwrite", { path: rel });
        const check = BaseDoc.safeParse(input.base);
        if (!check.success)
          throw err.basesSyntaxError("base definition is invalid", { issues: check.error.issues });
        requireConfirmation(ctx, "create_base", input, ex.exists && input.overwrite, { path: rel });
        const content = serializeBase(input.base);
        writeNoteAtomic(abs, content, input.options.create_dirs);
        return {
          vault: v.id,
          path: rel,
          created: !ex.exists,
          content_hash: contentHash(content),
        };
      },
    }),

    defineTool({
      name: "update_base",
      description:
        "Patch a .base file's source/views/formulas. Unknown keys are preserved. Changing `source` requires confirmation.",
      inputSchema: UpdateInput,
      requiredScopes: ["write:bases"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        requireBaseExt(rel);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "write", rel, v.root);
        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("base not found", { path: rel });
        const { raw: text, hash } = readNote(abs);
        if (input.prev_hash !== undefined && input.prev_hash !== hash)
          throw err.concurrentModification("base changed since prev_hash", {
            path: rel,
            expected: input.prev_hash,
            actual: hash,
          });
        const patch = input.patch;
        requireConfirmation(ctx, "update_base", input, patch.source !== undefined, {
          path: rel,
          source_change: patch.source !== undefined,
        });

        const { raw } = parseBase(text);
        const applied = {
          views_added: 0,
          views_removed: 0,
          views_updated: 0,
          source_changed: false,
        };
        if (patch.source !== undefined) {
          raw.source = patch.source;
          applied.source_changed = true;
        }
        if (patch.remove_views?.length) {
          const set = new Set(patch.remove_views);
          const before = baseViews(raw).length;
          raw.views = baseViews(raw).filter((view) => !set.has(String(view.name)));
          applied.views_removed = before - (raw.views as unknown[]).length;
        }
        if (patch.update_views) {
          for (const [name, p] of Object.entries(patch.update_views)) {
            const view = baseViews(raw).find((view) => String(view.name) === name);
            if (view) {
              Object.assign(view, p);
              applied.views_updated++;
            }
          }
        }
        if (patch.add_views?.length) {
          if (!Array.isArray(raw.views)) raw.views = [];
          (raw.views as Record<string, unknown>[]).push(...patch.add_views);
          applied.views_added = patch.add_views.length;
        }
        if (patch.formulas) {
          const cur = isLogicObject(raw.formulas) ? raw.formulas : {};
          raw.formulas = { ...cur, ...patch.formulas };
        }

        const check = BaseDoc.safeParse(raw);
        if (!check.success)
          throw err.basesSyntaxError("resulting base is invalid", { issues: check.error.issues });
        const content = serializeBase(raw);
        writeNoteAtomic(abs, content, false);
        return {
          vault: v.id,
          path: rel,
          applied,
          content_hash: contentHash(content),
          prev_hash: hash,
        };
      },
    }),

    defineTool({
      name: "query_base",
      description:
        "Execute a base view and return the resolved rows. Filters are JSONLogic over each note; JSONLogic formulas are computed as columns.",
      inputSchema: QueryInput,
      requiredScopes: ["read:bases"],
      handler: (input, ctx) => {
        const v = deps.vaultRegistry.resolve(input.vault);
        const rel = normalizeVaultPath(input.path);
        requireBaseExt(rel);
        const abs = resolveVaultPath(v.root, rel);
        enforcePathAcl(ctx.acl, "read", rel, v.root);
        const ex = noteExists(abs);
        if (!ex.exists || ex.type === "folder")
          throw err.noteNotFound("base not found", { path: rel });
        const { raw } = parseBase(readNote(abs).raw);
        const view = selectView(raw, input.view);
        if (input.view && !view) throw err.invalidInput("view not found", { view: input.view });

        const source = isLogicObject(raw.source) ? raw.source : undefined;
        const sType = source ? String(source.type) : undefined;
        const sValue = source?.value;
        const formulas = isLogicObject(raw.formulas)
          ? Object.entries(raw.formulas).filter(([, expr]) => isLogicObject(expr))
          : [];
        const viewFilters = view && isLogicObject(view.filters) ? view.filters : undefined;
        const override = isLogicObject(input.override_filters) ? input.override_filters : undefined;
        const colNames = view && Array.isArray(view.columns) ? (view.columns as string[]) : [];

        let candidates = walkVault(v.root, { extensions: [".md"] })
          .map((e) => e.relPath)
          .filter((p) => readableAcl(ctx.acl, p));
        if (sType === "folder") {
          const f = normalizeVaultPath(String(sValue ?? ""));
          candidates = f === "" ? candidates : candidates.filter((p) => p.startsWith(`${f}/`));
        }
        let linkTarget: string | null | undefined;
        const index = sType === "link" ? buildVaultIndex(candidates) : undefined;
        if (sType === "link" && index) {
          const r = resolveTarget(index, String(sValue ?? ""));
          linkTarget = r.resolved ? (r.target_path ?? null) : null;
        }

        const rows: Array<{ note_path: string; columns: Record<string, unknown> }> = [];
        for (const p of candidates) {
          const { frontmatter, body } = parseNote(readNote(resolveVaultPath(v.root, p)).raw);
          const fm = frontmatter ?? {};
          const tags = normTags(fm);
          if (sType === "tag" && !tags.includes(String(sValue).replace(/^#/, ""))) continue;
          if (sType === "property" && !Object.hasOwn(fm, String(sValue))) continue;
          if (sType === "link") {
            if (!linkTarget || !index) continue;
            const hit = extractLinks(body).some((l) => {
              const rr = resolveTarget(index, l.target);
              return rr.resolved && rr.target_path === linkTarget;
            });
            if (!hit) continue;
          }
          const data: Record<string, unknown> = {
            ...fm,
            path: p,
            name: baseName(p),
            tags,
            content: body,
          };
          if (viewFilters && !evaluatesTruthy(viewFilters, data)) continue;
          if (override && !evaluatesTruthy(override, data)) continue;

          const columns: Record<string, unknown> = {};
          if (colNames.length) for (const c of colNames) columns[c] = colValue(c, p, fm);
          else columns.path = p;
          for (const [name, expr] of formulas) {
            try {
              columns[name] = applyLogic(expr, data);
            } catch {
              columns[name] = null; // a formula that references a missing/incompatible field yields null
            }
          }
          rows.push({ note_path: p, columns });
        }

        const limit = input.limit ?? 100;
        const start = input.cursor ? Math.max(0, Number.parseInt(input.cursor, 10) || 0) : 0;
        const page = rows.slice(start, start + limit);
        const nextStart = start + page.length;
        const next = nextStart < rows.length ? String(nextStart) : undefined;
        return {
          vault: v.id,
          path: rel,
          view_used: view && typeof view.name === "string" ? view.name : null,
          total: rows.length,
          items: page,
          ...(next ? { next_cursor: next } : {}),
        };
      },
    }),
  ];
}
