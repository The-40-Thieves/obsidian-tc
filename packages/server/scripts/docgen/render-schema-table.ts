// docgen — JSON Schema -> parameter table rows. Reads the schema `describeCapability` advertises
// (Zod -> JSON Schema 2020-12 via the facade's own converter), so defaults and required-ness match
// what a client sees. Objects flatten to dotted paths, arrays to `path[]`, and union variants merge
// into one row per path.
import { cell } from "./render-tools";

type Schema = Record<string, unknown>;

export interface ParamRow {
  path: string;
  type: string;
  /** "yes", "with parent" (required inside an optional object), or "". */
  required: string;
  /** Rendered default, or "" when the schema declares none. */
  def: string;
  notes: string;
}

const MAX_DEPTH = 6;
const SAFE_INT_MAX = Number.MAX_SAFE_INTEGER;

const isObj = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);
const variantsOf = (s: Schema): Schema[] | undefined => {
  const v = s.anyOf ?? s.oneOf;
  return Array.isArray(v) ? v.filter(isObj) : undefined;
};
const literal = (v: unknown): string => JSON.stringify(v);

/** Compact type label for a schema node (no recursion into object fields). */
export function typeOf(s: Schema): string {
  if ("const" in s) return literal(s.const);
  if (Array.isArray(s.enum)) return "enum";
  const variants = variantsOf(s);
  if (variants) return [...new Set(variants.map(typeOf))].join(" | ");
  if ("$ref" in s) return "object (recursive)";
  const t = s.type;
  if (Array.isArray(t)) return t.join(" | ");
  if (t === "array") return `${isObj(s.items) ? typeOf(s.items) : "any"}[]`;
  if (t === "object") {
    if (!isObj(s.properties) && isObj(s.additionalProperties)) {
      return `Record<string, ${typeOf(s.additionalProperties)}>`;
    }
    return "object";
  }
  return typeof t === "string" ? t : "any";
}

function constraints(s: Schema): string[] {
  const out: string[] = [];
  if (Array.isArray(s.enum))
    out.push(`One of: ${s.enum.map((v) => `\`${literal(v)}\``).join(", ")}`);
  const range = (lo: unknown, hi: unknown, label: string): void => {
    const l = typeof lo === "number" ? lo : undefined;
    const h = typeof hi === "number" && hi < SAFE_INT_MAX ? hi : undefined;
    if (l !== undefined && h !== undefined) out.push(`${label} ${l}–${h}`);
    else if (l !== undefined) out.push(`${label} ≥ ${l}`);
    else if (h !== undefined) out.push(`${label} ≤ ${h}`);
  };
  range(s.minLength, s.maxLength, "length");
  range(s.minimum, s.maximum, "range");
  range(s.minItems, s.maxItems, "items");
  if (typeof s.pattern === "string") out.push(`pattern \`${s.pattern}\``);
  if (typeof s.format === "string") out.push(`format ${s.format}`);
  return out;
}

function renderDefault(s: Schema): string {
  if (!("default" in s)) return "";
  const json = JSON.stringify(s.default) ?? "";
  return json.length > 60 ? `${json.slice(0, 57)}...` : json;
}

/** What a field that is required by its own parent reads as, given where it sits. */
type Ctx = "yes" | "with parent" | "in variant";

/** Flatten `schema` into rows, in schema order. */
export function schemaRows(schema: unknown, opts: { maxDepth?: number } = {}): ParamRow[] {
  if (!isObj(schema)) return [];
  const maxDepth = opts.maxDepth ?? MAX_DEPTH;
  const rows = new Map<string, ParamRow>();

  const add = (row: ParamRow): void => {
    const prev = rows.get(row.path);
    if (!prev) {
      rows.set(row.path, row);
      return;
    }
    // Same path reached through several union variants: union the types, keep the first default,
    // and only keep a required marker every variant agrees on.
    prev.type = [...new Set([...prev.type.split(" | "), ...row.type.split(" | ")])].join(" | ");
    if (!prev.def) prev.def = row.def;
    if (row.notes && !prev.notes.includes(row.notes)) {
      prev.notes = [prev.notes, row.notes].filter(Boolean).join(" ");
    }
    if (prev.required !== row.required) prev.required = "";
  };

  const walkObject = (s: Schema, prefix: string, depth: number, ctx: Ctx): void => {
    const props = isObj(s.properties) ? s.properties : {};
    const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    for (const [key, raw] of Object.entries(props)) {
      if (!isObj(raw)) continue;
      const isRequired = required.has(key);
      const path = prefix ? `${prefix}.${key}` : key;
      const notes = [
        typeof raw.description === "string" ? raw.description : "",
        constraints(raw).join("; "),
      ]
        .filter(Boolean)
        .join(" ");
      add({
        path,
        type: typeOf(raw),
        required: isRequired ? ctx : "",
        def: renderDefault(raw),
        notes,
      });
      if (depth < maxDepth) {
        const childCtx: Ctx = isRequired || ctx === "in variant" ? ctx : "with parent";
        descend(raw, path, depth + 1, childCtx);
      }
    }
  };

  const descend = (s: Schema, path: string, depth: number, ctx: Ctx): void => {
    if (isObj(s.properties)) walkObject(s, path, depth, ctx);
    if (isObj(s.items)) descend(s.items, `${path}[]`, depth, ctx);
    // A nullable (`T | null`) is one shape, not a choice between shapes, so it keeps the context.
    const variants = (variantsOf(s) ?? []).filter((v) => v.type !== "null");
    const vctx: Ctx = variants.length > 1 ? "in variant" : ctx;
    for (const v of variants) descend(v, path, depth, vctx);
  };

  // The root is an object, or a union of objects whose fields only apply per variant.
  descend(schema, "", 1, "yes");
  return [...rows.values()];
}

/** GFM table for `rows`; `withDefault` adds the Default column (inputs only). */
export function renderRowsTable(rows: ParamRow[], withDefault: boolean): string {
  const head = withDefault
    ? ["| Parameter | Type | Required | Default | Description |", "|---|---|---|---|---|"]
    : ["| Field | Type | Always present | Description |", "|---|---|---|---|"];
  const body = rows.map((r) => {
    const cells = [`\`${cell(r.path)}\``, `\`${cell(r.type)}\``, r.required];
    if (withDefault) cells.push(r.def ? `\`${cell(r.def)}\`` : "—");
    cells.push(cell(r.notes) || "—");
    return `| ${cells.join(" | ")} |`;
  });
  return [...head, ...body].join("\n");
}
