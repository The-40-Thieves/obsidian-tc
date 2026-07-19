// Domain 7 — Bases (.base). Four tools: read_base, create_base, update_base,
// query_base. Round-trip safe: parse/serialize go through the YAML codec and writes
// mutate the parsed mapping in place, so unknown keys (real Obsidian `filters`,
// `properties`, per-view `order`/`limit`, ...) survive. Confirmation is conditional:
// overwriting an existing base and changing a base's `source` (which can invalidate
// every view) require a HITL elicit token. query_base interprets the format: a
// view's `filters` (and any `override_filters`) are JSONLogic over each note's
// { ...frontmatter, path, name, tags, content }; `formulas` whose value is a
// JSONLogic object are computed per row and added as columns. A base written with the
// real Obsidian Bases expression DSL (a bare-string filter, an and/or/not of string
// statements, a top-level `filters`, or a string formula) is REFUSED with a typed
// unsupported_base_filter rather than silently matching all rows (THE-284; the Bases
// DSL evaluator is THE-281).
import {
  err,
  ObsidianTcError,
  Pagination,
  VaultId,
  VaultPath,
  WriteOptions,
} from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import { BaseDoc, baseViews, parseBase, selectView, serializeBase } from "../../formats/base";
import {
  type BasesNoteCtx,
  classifyBaseFilter,
  evaluateBasesExpr,
  evaluateBasesFilter,
  parseBasesExpr,
} from "../../formats/bases-expr";
import type { ToolDefinition } from "../../mcp/registry";
import { applyLogic, evaluatesTruthy } from "../../search/jsonlogic";
import { enforcePathAcl } from "../../vault/acl-path";
import { readableRel } from "../../vault/acl-read-filter";
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
        // THE-280 — real Bases top-level keys (filters is note-set-defining, so it is
        // HITL-gated exactly like the deprecated source alias).
        filters: z.unknown().optional(),
        properties: z.record(z.string(), z.unknown()).optional(),
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
    // THE-281: a string override is the Bases DSL; an object stays JSONLogic.
    override_filters: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
  })
  .merge(Pagination)
  .strict();

export function buildBaseTools(deps: M3Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "read_base",
      pathAcl: (input) => [{ op: "read", path: input.path }],
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
      pathAcl: (input) => [{ op: "write", path: input.path }],
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
        // THE-280: surface the obsidian-tc aliases as deprecations (removal at v2.0) so authors
        // migrate toward real Bases shapes (top-level filters; per-view order/groupBy).
        const deprecations: string[] = [];
        const doc = input.base as Record<string, unknown>;
        if (doc.source !== undefined)
          deprecations.push(
            "`source` is an obsidian-tc alias; real Bases selects notes via top-level `filters` (removal at v2.0)",
          );
        const inViews = Array.isArray(doc.views) ? (doc.views as Record<string, unknown>[]) : [];
        if (inViews.some((vv) => Array.isArray(vv.columns)))
          deprecations.push(
            "per-view `columns` is an obsidian-tc alias for real Bases `order` (removal at v2.0)",
          );
        if (inViews.some((vv) => vv.group !== undefined))
          deprecations.push(
            "per-view `group` is a deprecated alias for real Bases `groupBy` (removal at v2.0)",
          );
        return {
          vault: v.id,
          path: rel,
          created: !ex.exists,
          content_hash: contentHash(content),
          ...(deprecations.length ? { deprecations } : {}),
        };
      },
    }),

    defineTool({
      name: "update_base",
      pathAcl: (input) => [{ op: "write", path: input.path }],
      description:
        "Patch a .base file's source/filters/properties/views/formulas. Unknown keys are preserved. Changing `source` (deprecated alias) or the note-set-defining top-level `filters` requires confirmation.",
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
        requireConfirmation(
          ctx,
          "update_base",
          input,
          patch.source !== undefined || patch.filters !== undefined,
          {
            path: rel,
            source_change: patch.source !== undefined,
            filters_change: patch.filters !== undefined,
          },
        );

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
        // THE-280: real Bases top-level keys are applied, not silently accepted.
        if (patch.filters !== undefined) raw.filters = patch.filters;
        if (patch.properties !== undefined) raw.properties = patch.properties;
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
      pathAcl: (input) => [{ op: "read", path: input.path }],
      description:
        "Execute a base view and return resolved rows. Filters/formulas may use obsidian-tc's JSONLogic model OR the real Obsidian Bases expression DSL (a documented subset, THE-281); constructs outside the subset — and trees mixing both models — are refused with unsupported_base_filter.",
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

        // THE-281: pure string / combinator-of-strings filters are the real Bases DSL, evaluated
        // by the subset evaluator; pure-JSONLogic objects keep the legacy path; MIXED trees still
        // refuse with the same typed code (evaluating half a tree in each engine risks silent
        // mis-evaluation — the THE-284 honesty contract).
        const clsTop = classifyBaseFilter(raw.filters);
        const clsView = classifyBaseFilter(view?.filters);
        const clsOver = classifyBaseFilter(input.override_filters);
        for (const [cls, expr] of [
          [clsTop, raw.filters],
          [clsView, view?.filters],
          [clsOver, input.override_filters],
        ] as const) {
          if (cls === "mixed")
            throw err.unsupportedBaseFilter(
              "this base mixes Bases DSL strings and JSONLogic objects in one filter tree, which query_base does not evaluate",
              { expression: JSON.stringify(expr).slice(0, 200) },
            );
        }

        const source = isLogicObject(raw.source) ? raw.source : undefined;
        const sType = source ? String(source.type) : undefined;
        const sValue = source?.value;
        const formulaEntries = isLogicObject(raw.formulas) ? Object.entries(raw.formulas) : [];
        const formulas = formulaEntries.filter(([, expr]) => isLogicObject(expr));
        // THE-281: parse string formulas ONCE up front — a syntax/unsupported error refuses the
        // whole query (typed), never a silent null column on every row.
        const dslFormulas = formulaEntries
          .filter((e): e is [string, string] => typeof e[1] === "string")
          .map(([name, src]) => [name, parseBasesExpr(src)] as const);
        const viewFilters =
          clsView === "jsonlogic" && view && isLogicObject(view.filters) ? view.filters : undefined;
        const override =
          clsOver === "jsonlogic" && isLogicObject(input.override_filters)
            ? input.override_filters
            : undefined;
        const colNames = view && Array.isArray(view.columns) ? (view.columns as string[]) : [];
        // THE-280: real Bases view keys, previously round-tripped but IGNORED at query time.
        // `columns` (deprecated alias) wins over `order` for projection in v1.x; `order`'s
        // namespaced ids (file.*/note.*/formula.*) project when columns is absent. `limit`
        // caps the result set; `sort` (strings or {property, direction}) orders it; `groupBy`
        // (or the deprecated `group` alias) attaches an additive `group` key and groups rows.
        const orderIds =
          view && Array.isArray(view.order)
            ? (view.order as unknown[]).filter((x): x is string => typeof x === "string")
            : [];
        const viewLimit =
          view && typeof view.limit === "number" && view.limit > 0 ? view.limit : undefined;
        const sortSpec = view && Array.isArray(view.sort) ? (view.sort as unknown[]) : [];
        const rawGroupBy = view
          ? ((view as Record<string, unknown>).groupBy ?? view.group)
          : undefined;
        const groupProp =
          typeof rawGroupBy === "string"
            ? rawGroupBy
            : isLogicObject(rawGroupBy) && typeof rawGroupBy.property === "string"
              ? rawGroupBy.property
              : undefined;
        const groupDesc = isLogicObject(rawGroupBy) && rawGroupBy.direction === "DESC";
        const idValue = (
          id: string,
          p: string,
          fm: Record<string, unknown>,
          columns: Record<string, unknown>,
        ): unknown => {
          if (id.startsWith("formula.")) return columns[id.slice(8)] ?? null;
          if (id.startsWith("note.")) return fm[id.slice(5)] ?? null;
          if (id === "file.folder") {
            const i = p.lastIndexOf("/");
            return i < 0 ? "" : p.slice(0, i);
          }
          if (id === "file.ext") return "md";
          return colValue(id, p, fm); // file.name / file.path / bare property
        };

        let candidates = walkVault(v.root, { extensions: [".md"] })
          .map((e) => e.relPath)
          .filter((p) => readableRel(ctx.acl, p));
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

        const rows: Array<{
          note_path: string;
          columns: Record<string, unknown>;
          group?: unknown;
        }> = [];
        const sortKeys: unknown[][] = [];
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
          const basesCtx: BasesNoteCtx = {
            path: p,
            frontmatter: fm,
            tags,
            links: extractLinks(body).map((l) => l.target),
          };
          // THE-281: a pure-DSL top-level `filters` (real Bases has NO source block — the note
          // set IS the top-level filters) narrows the note set; previously it was refused.
          if (clsTop === "dsl" && !evaluateBasesFilter(raw.filters, basesCtx)) continue;
          if (clsView === "dsl" && !evaluateBasesFilter(view?.filters, basesCtx)) continue;
          if (viewFilters && !evaluatesTruthy(viewFilters, data)) continue;
          if (clsOver === "dsl" && !evaluateBasesFilter(input.override_filters, basesCtx)) continue;
          if (override && !evaluatesTruthy(override, data)) continue;

          const columns: Record<string, unknown> = {};
          if (colNames.length) for (const c of colNames) columns[c] = colValue(c, p, fm);
          else if (!orderIds.length) columns.path = p;
          for (const [name, expr] of formulas) {
            try {
              columns[name] = applyLogic(expr, data);
            } catch {
              columns[name] = null; // a formula that references a missing/incompatible field yields null
            }
          }
          basesCtx.formulas = columns;
          for (const [name, ast] of dslFormulas) {
            try {
              columns[name] = evaluateBasesExpr(ast, basesCtx);
            } catch (e) {
              // Unsupported constructs stay typed refusals (never a silent null column); per-row
              // data errors (missing/mismatched fields) yield null like the JSONLogic formulas.
              if (e instanceof ObsidianTcError && e.code === "unsupported_base_filter") throw e;
              columns[name] = null;
            }
          }
          // THE-280: `order` projects AFTER formulas so formula.* ids resolve.
          if (!colNames.length && orderIds.length)
            for (const c of orderIds) columns[c] = idValue(c, p, fm, columns);
          rows.push({
            note_path: p,
            columns,
            ...(groupProp !== undefined
              ? { group: idValue(groupProp, p, fm, columns) ?? null }
              : {}),
          });
          sortKeys.push(
            sortSpec.map((s) => {
              const id =
                typeof s === "string"
                  ? s
                  : isLogicObject(s) && typeof s.property === "string"
                    ? s.property
                    : "";
              return id ? idValue(id, p, fm, columns) : null;
            }),
          );
        }

        // THE-280: honor sort / groupBy / limit (previously round-tripped but ignored).
        if (sortSpec.length || groupProp !== undefined) {
          const dirs = sortSpec.map((s) => (isLogicObject(s) && s.direction === "DESC" ? -1 : 1));
          const cmpVals = (a: unknown, b: unknown): number => {
            const x = a ?? "";
            const y = b ?? "";
            if (typeof x === "number" && typeof y === "number") return x - y;
            const xs = String(x);
            const ys = String(y);
            return xs < ys ? -1 : xs > ys ? 1 : 0;
          };
          const idx = rows.map((_, i) => i);
          idx.sort((ia, ib) => {
            if (groupProp !== undefined) {
              const g = cmpVals(rows[ia]?.group, rows[ib]?.group) * (groupDesc ? -1 : 1);
              if (g !== 0) return g;
            }
            for (let k = 0; k < sortSpec.length; k++) {
              const c = cmpVals(sortKeys[ia]?.[k], sortKeys[ib]?.[k]) * (dirs[k] ?? 1);
              if (c !== 0) return c;
            }
            return ia - ib; // stable
          });
          const sorted = idx.map((i) => rows[i] as (typeof rows)[number]);
          rows.length = 0;
          rows.push(...sorted);
        }
        if (viewLimit !== undefined && rows.length > viewLimit) rows.length = viewLimit;

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
