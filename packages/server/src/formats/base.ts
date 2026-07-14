// Obsidian Bases (.base) codec. The .base format is YAML; G2.1 models a base as
// { source, views[], formulas } but real files (and future plugin versions) carry
// extra keys (top-level `filters`, `properties`, per-view `order`/`limit`, ...).
// Round-trip fidelity is mandatory, so parseBase keeps the whole on-disk mapping
// (validation is shape-only via passthrough) and writes mutate it in place. The
// reused YAML engine does not preserve comments (a documented limitation it shares
// with the M1 frontmatter engine); keys and values are preserved. Malformed YAML or
// a non-mapping root throws bases_syntax_error.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import YAML from "yaml";
import { z } from "zod";

export const BaseSource = z
  .object({
    type: z.enum(["tag", "folder", "link", "property"]),
    value: z.unknown(),
  })
  .passthrough();

export const BaseView = z
  .object({
    name: z.string().optional(),
    type: z.string().optional(),
    filters: z.unknown().optional(),
    sort: z.unknown().optional(),
    /** Deprecated obsidian-tc alias for real Bases `groupBy` (removal at v2.0). */
    group: z.unknown().optional(),
    /** Deprecated obsidian-tc alias for real Bases `order` (removal at v2.0). */
    columns: z.array(z.string()).optional(),
    // THE-280 — real Obsidian Bases view keys (namespaced property ids: file.*/note.*/formula.*).
    order: z.array(z.string()).optional(),
    limit: z.number().int().positive().optional(),
    groupBy: z.unknown().optional(),
  })
  .passthrough();

export const BaseDoc = z
  .object({
    /** Deprecated obsidian-tc alias: real Bases has NO source block — the note set is the
     *  top-level `filters` (removal at v2.0). */
    source: BaseSource.optional(),
    views: z.array(BaseView).optional(),
    formulas: z.record(z.string(), z.unknown()).optional(),
    // THE-280 — real Obsidian Bases top-level keys.
    filters: z.unknown().optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export interface ParsedBase {
  /** The on-disk mapping — mutate this for writes so unknown keys are preserved. */
  raw: Record<string, unknown>;
}

/** Parse + structurally validate a .base document. Throws bases_syntax_error. */
export function parseBase(text: string): ParsedBase {
  let obj: unknown;
  try {
    obj = YAML.parse(text) ?? {};
  } catch {
    throw err.basesSyntaxError("base is not valid YAML");
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj))
    throw err.basesSyntaxError("base root must be a YAML mapping");
  const raw = obj as Record<string, unknown>;
  const res = BaseDoc.safeParse(raw);
  if (!res.success)
    throw err.basesSyntaxError("base structure is invalid", { issues: res.error.issues });
  return { raw };
}

/** Serialize a base mapping (the raw, mutated form) back to YAML text. */
export function serializeBase(raw: Record<string, unknown>): string {
  return YAML.stringify(raw, { lineWidth: 0 });
}

/** The views array of a base, or [] when absent. */
export function baseViews(raw: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(raw.views) ? (raw.views as Record<string, unknown>[]) : [];
}

/** Find a view by name, or the first view when name is omitted. */
export function selectView(
  raw: Record<string, unknown>,
  name?: string,
): Record<string, unknown> | undefined {
  const views = baseViews(raw);
  if (name === undefined) return views[0];
  return views.find((v) => v.name === name);
}
