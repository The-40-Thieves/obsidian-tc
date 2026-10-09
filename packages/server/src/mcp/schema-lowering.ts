// Lowers the JSON Schema zod emits into the PORTABLE SUBSET before it is advertised (tools/list and
// describe_capability both go through facade.ts's toJson / toInputJson, the one place a schema leaves
// the process). MCP clients disagree on which JSON Schema they accept: Copilot Studio drops tools whose
// schema holds a `$ref` and truncates at a `type` array, Codex collapses `$ref` to a string, Cursor
// blanks the whole server on a non-object outputSchema root, Gemini / Vertex / ADK take an OpenAPI 3.0
// subset (no `const` / `oneOf` / `allOf`, `anyOf` alone, `items` on every array, string enums), OpenAI
// rejects root combinators and regex lookaround, and Claude Desktop rejects a draft-07 `$schema`.
//
// Only the ADVERTISED copy changes. Dispatch still validates with the original zod schema, so every
// constraint dropped here is still enforced server-side. The invariants, proven for every registered
// tool by test/schema-lowering-roundtrip.test.ts:
//   OUTPUTS: everything the server emits validates against the advertised schema. An output whose
//     root cannot honestly be `type: object` (z.unknown(), a union admitting an array) is not
//     advertised at all (lowerOutputSchema returns undefined) instead of being coerced.
//   INPUTS: the advertised schema is NARROWER in exactly one way - an explicit `null` for a nullable
//     optional field is not advertised, though the server's zod still accepts it - and WIDER where a
//     constraint was dropped (restated in the description; zod still enforces it).
// Where a dropped constraint would have told a model something, an INPUT description gets a short
// sentence appended; a description is never touched otherwise, because claude.ai keys "Always allow"
// on a hash of the descriptions. Output descriptions are never edited.

export type SchemaRole = "input" | "output";
/** How many times each rewrite fired; the schema-portability gate asserts it is non-empty. */
export type LoweringReport = Record<string, number>;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

// Counted whenever a root that admits a non-object value is forced to `type: object`.
const ROOT_COERCED = "root-coerced";
const SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";
// OpenAI structured-outputs `format` list; any other format is dropped.
const PORTABLE_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uuid",
]);
const LOOKAROUND_OR_BACKREF = /\(\?<?[=!]|\\[1-9]|\\k</;
// Keywords outside the portable subset that carry no constraint worth describing.
const DROPPED = [
  "not",
  "if",
  "then",
  "else",
  "patternProperties",
  "dependentSchemas",
  "dependentRequired",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contains",
  "$id",
  "$anchor",
  "$dynamicRef",
  "$dynamicAnchor",
  "$comment",
];
// Siblings of a `type` array that belong to one member type, so each member keeps its own.
const SIBLINGS_BY_TYPE: Record<string, readonly string[]> = {
  string: ["minLength", "maxLength", "pattern", "format"],
  number: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
  integer: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
  array: ["items", "prefixItems", "minItems", "maxItems", "uniqueItems"],
  object: ["properties", "required", "additionalProperties", "propertyNames"],
};

interface Ctx {
  role: SchemaRole;
  defs: Json;
  stack: string[];
  report: LoweringReport;
}
const count = (ctx: Ctx, key: string): void => {
  ctx.report[key] = (ctx.report[key] ?? 0) + 1;
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function refTarget(ref: string, ctx: Ctx, root: Json): { name: string; target: unknown } {
  if (ref === "#") return { name: "#", target: root };
  const m = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
  const name =
    m?.[1] === undefined ? ref : decodeURIComponent(m[1]).replace(/~1/g, "/").replace(/~0/g, "~");
  return { name, target: ctx.defs[name] };
}

function lowerRef(node: Json, ctx: Ctx, root: Json, notes: string[]): Json {
  const { $ref, ...siblings } = node;
  const { name, target } = refTarget(String($ref), ctx, root);
  if (ctx.stack.includes(name) || target === undefined) {
    count(ctx, ctx.stack.includes(name) ? "ref-recursive" : "ref-unresolved");
    if (ctx.role === "input") notes.push("Nested levels of this structure are not described here.");
    return { ...siblings, type: "object" };
  }
  count(ctx, "ref-inlined");
  ctx.stack.push(name);
  const out = lowerNode({ ...(isObj(target) ? target : {}), ...siblings }, ctx, root, false);
  ctx.stack.pop();
  return out;
}

/** `anyOf` branches that are all `{type, const}` become one `{type, enum}`. */
function mergeConstBranches(branches: unknown[]): Json | undefined {
  const first = branches[0];
  if (!isObj(first) || typeof first.type !== "string") return undefined;
  const ok = branches.every(
    (b) =>
      isObj(b) &&
      b.type === first.type &&
      "const" in b &&
      Object.keys(b).every((k) => k === "type" || k === "const"),
  );
  return ok ? { type: first.type, enum: branches.map((b) => (b as Json).const) } : undefined;
}

/** `allOf` of object schemas folds into one object; anything else becomes permissive. */
function mergeAllOf(node: Json, ctx: Ctx, root: Json): Json {
  const { allOf, ...rest } = node;
  const parts = (allOf as unknown[]).map((b) => lowerNode(b, ctx, root, false));
  const objects = parts.every((p) => p.type === "object" || p.type === undefined);
  count(ctx, objects ? "allof-merged" : "allof-dropped");
  if (!objects) return rest;
  const props: Json = {};
  const required = new Set<string>(Array.isArray(rest.required) ? (rest.required as string[]) : []);
  for (const p of parts) {
    Object.assign(props, isObj(p.properties) ? p.properties : {});
    for (const r of Array.isArray(p.required) ? (p.required as string[]) : []) required.add(r);
  }
  const merged: Json = {
    ...rest,
    type: "object",
    properties: { ...props, ...(isObj(rest.properties) ? rest.properties : {}) },
  };
  if (required.size > 0) merged.required = [...required];
  return merged;
}

/** A `type` array becomes an `anyOf` of single types, each keeping its own sibling constraints. */
function splitTypeArray(node: Json, ctx: Ctx): Json {
  const { type, ...rest } = node;
  count(ctx, "type-array");
  const owned = new Set<string>();
  const branches = (type as unknown[]).map((t) => {
    const branch: Json = { type: t };
    for (const k of SIBLINGS_BY_TYPE[String(t)] ?? []) {
      if (k in rest) {
        branch[k] = rest[k];
        owned.add(k);
      }
    }
    return branch;
  });
  const outer: Json = { anyOf: branches };
  for (const [k, v] of Object.entries(rest)) if (!owned.has(k)) outer[k] = v;
  return outer;
}

function stripAdditionalProperties(node: unknown, ctx: Ctx): unknown {
  if (Array.isArray(node)) return node.map((n) => stripAdditionalProperties(n, ctx));
  if (!isObj(node)) return node;
  const out: Json = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "additionalProperties") {
      count(ctx, "additionalProperties-stripped");
      continue;
    }
    out[k] =
      k === "properties" && isObj(v)
        ? Object.fromEntries(
            Object.entries(v).map(([pk, pv]) => [pk, stripAdditionalProperties(pv, ctx)]),
          )
        : stripAdditionalProperties(v, ctx);
  }
  return out;
}

/** Normalises lowered `anyOf` branches: flatten, dedupe, drop input nulls (the one input narrowing). */
function finishAnyOf(rest: Json, branches: Json[], ctx: Ctx): Json {
  let flat = branches.flatMap((b) =>
    Array.isArray(b.anyOf) && Object.keys(b).length === 1 ? (b.anyOf as Json[]) : [b],
  );
  if (ctx.role === "input") {
    const kept = flat.filter((b) => b.type !== "null");
    if (kept.length !== flat.length) count(ctx, "null-branch-dropped");
    flat = kept;
  }
  flat = flat.filter((b, i) => flat.findIndex((o) => same(o, b)) === i);
  const first = flat[0];
  if (flat.length === 1 && first !== undefined) {
    const merged: Json = {
      ...first,
      ...Object.fromEntries(Object.entries(rest).filter(([k]) => k !== "anyOf" && k !== "oneOf")),
    };
    // Both levels may describe the value (the branch's may carry a dropped-constraint note).
    const inner = typeof first.description === "string" ? first.description : undefined;
    if (inner !== undefined && typeof rest.description === "string" && inner !== rest.description) {
      merged.description = `${rest.description} ${inner}`;
    }
    return merged;
  }
  const { description } = rest;
  if (Object.keys(rest).some((k) => k !== "description" && k !== "anyOf" && k !== "oneOf"))
    count(ctx, "anyof-siblings-dropped");
  const clean = flat.map((b) => stripAdditionalProperties(b, ctx) as Json);
  if (typeof description === "string" && clean[0] !== undefined)
    clean[0] = { ...clean[0], description };
  return { anyOf: clean };
}

/** A union of objects folds into one object: union of properties, intersection of required. */
function mergeObjectUnion(rest: Json, branches: Json[], ctx: Ctx, isRoot: boolean): Json {
  count(ctx, isRoot ? "root-union-merged" : "object-union-merged");
  if (!branches.every((b) => b.type === "object")) {
    if (isRoot) count(ctx, ROOT_COERCED);
    return { ...rest, type: "object" };
  }
  const keys = [
    ...new Set(branches.flatMap((b) => Object.keys(isObj(b.properties) ? b.properties : {}))),
  ];
  const properties: Json = {};
  for (const k of keys) {
    const variants = branches.flatMap((b) =>
      isObj(b.properties) && k in b.properties ? [b.properties[k] as Json] : [],
    );
    properties[k] = variants.length === 1 ? variants[0] : mergeVariants(variants, ctx);
  }
  const requiredOf = (b: Json): string[] =>
    Array.isArray(b.required) ? (b.required as string[]) : [];
  const first = requiredOf(branches[0] ?? {});
  const required = first.filter((r) => branches.every((b) => requiredOf(b).includes(r)));
  const out: Json = {
    ...rest,
    type: "object",
    properties: { ...(isObj(rest.properties) ? rest.properties : {}), ...properties },
  };
  if (required.length > 0) out.required = required;
  if (branches.every((b) => b.additionalProperties === false)) out.additionalProperties = false;
  return out;
}

function mergeVariants(variants: Json[], ctx: Ctx): Json {
  const uniq = variants.filter((v, i) => variants.findIndex((o) => same(o, v)) === i);
  if (uniq.length === 1 && uniq[0] !== undefined) return uniq[0];
  const enumOnly = uniq.every(
    (v) => v.type === "string" && Array.isArray(v.enum) && Object.keys(v).length === 2,
  );
  if (enumOnly)
    return { type: "string", enum: [...new Set(uniq.flatMap((v) => v.enum as string[]))] };
  return finishAnyOf({}, uniq, ctx);
}

function lowerNumberBounds(out: Json, ctx: Ctx, notes: string[]): void {
  const integer = out.type === "integer";
  for (const [kw, base, sign] of [
    ["exclusiveMinimum", "minimum", 1],
    ["exclusiveMaximum", "maximum", -1],
  ] as const) {
    const v = out[kw];
    if (v === undefined) continue;
    delete out[kw];
    if (typeof v === "number" && integer) {
      const bound = sign === 1 ? Math.floor(v) + 1 : Math.ceil(v) - 1;
      const cur = out[base];
      out[base] =
        typeof cur === "number"
          ? sign === 1
            ? Math.max(cur, bound)
            : Math.min(cur, bound)
          : bound;
      count(ctx, "exclusive-bound-integer");
    } else {
      count(ctx, "exclusive-bound-dropped");
      if (typeof v === "number")
        notes.push(`Must be ${sign === 1 ? "greater" : "less"} than ${v}.`);
    }
  }
}

function lowerEnumAndConst(out: Json, ctx: Ctx, notes: string[]): void {
  if ("const" in out) {
    const c = out.const;
    delete out.const;
    if (typeof c === "string" && !("enum" in out)) {
      out.enum = [c];
      out.type ??= "string";
      count(ctx, "const-to-enum");
    } else {
      count(ctx, "const-dropped");
      if (typeof c === "boolean" || typeof c === "number") {
        out.type ??= typeof c === "number" ? "number" : "boolean";
        notes.push(`Must be ${JSON.stringify(c)}.`);
      }
    }
  }
  const values = out.enum;
  if (Array.isArray(values) && !values.every((v) => typeof v === "string")) {
    delete out.enum;
    count(ctx, "enum-dropped");
    notes.push(`Allowed values: ${values.map((v) => JSON.stringify(v)).join(", ")}.`);
    if (values.length > 0 && values.every((v) => typeof v === "number")) {
      out.type ??= "number";
      out.minimum ??= Math.min(...(values as number[]));
      out.maximum ??= Math.max(...(values as number[]));
    }
    if (values.length > 0 && values.every((v) => typeof v === "boolean")) out.type ??= "boolean";
  }
}

function lowerStringKeywords(out: Json, ctx: Ctx, notes: string[]): void {
  if (typeof out.pattern === "string" && LOOKAROUND_OR_BACKREF.test(out.pattern)) {
    notes.push(`Must match the regular expression ${out.pattern}`);
    delete out.pattern;
    count(ctx, "pattern-dropped");
  }
  if (typeof out.format === "string" && !PORTABLE_FORMATS.has(out.format)) {
    notes.push(`Format: ${out.format}.`);
    delete out.format;
    count(ctx, "format-dropped");
  }
}

function lowerChildren(out: Json, ctx: Ctx, root: Json): void {
  if (isObj(out.properties)) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([k, v]) => [k, lowerNode(v, ctx, root, false)]),
    );
  }
  if (isObj(out.items) || typeof out.items === "boolean")
    out.items = lowerNode(out.items, ctx, root, false);
  else if (Array.isArray(out.items) || ("prefixItems" in out && out.items === undefined)) {
    count(ctx, "tuple-items-dropped");
    out.items = {};
  }
  delete out.prefixItems;
  if (isObj(out.additionalProperties))
    out.additionalProperties = lowerNode(out.additionalProperties, ctx, root, false);
  if (Array.isArray(out.required)) out.required = [...new Set(out.required as string[])];
}

function lowerNode(input: unknown, ctx: Ctx, root: Json, isRoot: boolean): Json {
  if (!isObj(input)) {
    count(ctx, "boolean-subschema");
    return {};
  }
  const notes: string[] = [];
  if ("$ref" in input) return finalize(lowerRef(input, ctx, root, notes), notes, ctx);
  let node: Json = { ...input };
  if (!isRoot) delete node.$schema;
  delete node.$defs;
  delete node.definitions;
  if (Array.isArray(node.allOf)) node = mergeAllOf(node, ctx, root);
  if (Array.isArray(node.oneOf)) {
    count(ctx, "oneof-to-anyof");
    node.anyOf = [...(Array.isArray(node.anyOf) ? node.anyOf : []), ...node.oneOf];
    delete node.oneOf;
  }
  for (const kw of DROPPED) {
    if (kw in node) {
      count(ctx, `keyword-dropped:${kw}`);
      delete node[kw];
    }
  }
  if (isObj(node.propertyNames)) {
    const keys = node.propertyNames.enum;
    if (Array.isArray(keys) && ctx.role === "input") notes.push(`Keys: ${keys.join(", ")}.`);
  }
  if ("propertyNames" in node) {
    delete node.propertyNames;
    count(ctx, "propertynames-dropped");
  }
  if (Array.isArray(node.type)) node = splitTypeArray(node, ctx);
  if (Array.isArray(node.anyOf)) {
    const { anyOf, ...rest } = node;
    const merged = mergeConstBranches(anyOf as unknown[]);
    const branches = merged ? [merged] : (anyOf as unknown[]);
    const lowered = branches.map((b) => lowerNode(b, ctx, root, false));
    const restLowered = lowerSiblings(rest, ctx, root, notes);
    const objects = lowered.every((b) => b.type === "object" && isObj(b.properties));
    if (lowered.length > 1 && (isRoot || objects)) {
      return finalize(mergeObjectUnion(restLowered, lowered, ctx, isRoot), notes, ctx);
    }
    return finalize(finishAnyOf(restLowered, lowered, ctx), notes, ctx);
  }
  return finalize(lowerSiblings(node, ctx, root, notes), notes, ctx);
}

/** The non-union keywords of a node (everything except `anyOf`). */
function lowerSiblings(node: Json, ctx: Ctx, root: Json, notes: string[]): Json {
  const out: Json = { ...node };
  lowerEnumAndConst(out, ctx, notes);
  lowerNumberBounds(out, ctx, notes);
  lowerStringKeywords(out, ctx, notes);
  if (out.type === "array" && out.items === undefined) {
    out.items = {};
    count(ctx, "items-added");
  }
  lowerChildren(out, ctx, root);
  return out;
}

function finalize(node: Json, notes: string[], ctx: Ctx): Json {
  if (ctx.role !== "input" || notes.length === 0) return node;
  const [firstBranch, ...others] = Array.isArray(node.anyOf) ? (node.anyOf as Json[]) : [];
  if (firstBranch !== undefined) {
    // Nothing may sit beside an anyOf, so the note rides on its first branch.
    return { ...node, anyOf: [finalize(firstBranch, notes, ctx), ...others] };
  }
  const base = typeof node.description === "string" ? `${node.description} ` : "";
  return { ...node, description: `${base}${notes.join(" ")}`.trim() };
}

/**
 * The portable-subset copy of a zod-emitted JSON Schema. Pure: `schema` is not mutated, and the
 * result shares no state with it. `report`, when given, accumulates which rewrites fired.
 */
export function lowerSchema<T extends object>(
  schema: T,
  role: SchemaRole,
  report: LoweringReport = {},
): T {
  const root = schema as Json;
  const defs: Json = {
    ...(isObj(root.definitions) ? root.definitions : {}),
    ...(isObj(root.$defs) ? root.$defs : {}),
  };
  const ctx: Ctx = { role, defs, stack: ["#"], report };
  let out = lowerNode(root, ctx, root, true);
  if (out.type !== "object") {
    count(ctx, "root-type-set");
    count(ctx, ROOT_COERCED);
    const { type: _t, ...rest } = out;
    out = { ...rest, type: "object" };
  }
  if ("$schema" in root) {
    const { $schema: _stale, ...rest } = out;
    out = { $schema: SCHEMA_2020_12, ...rest };
  }
  return out as T;
}

/**
 * The advertisable copy of an OUTPUT schema, or `undefined` when its root cannot honestly be
 * `type: object` (typeless / z.unknown(), or a union admitting an array or a primitive). Forcing
 * `type: object` onto such a root would advertise a contract the tool breaks (a conformant client
 * rejects the array its handler legitimately returned), so the tool is listed without an
 * outputSchema instead. The one guard every output projection goes through (see facade.ts toJson).
 */
export function lowerOutputSchema<T extends object>(
  schema: T,
  report: LoweringReport = {},
): T | undefined {
  const local: LoweringReport = {};
  const out = lowerSchema(schema, "output", local);
  for (const [k, v] of Object.entries(local)) report[k] = (report[k] ?? 0) + v;
  return local[ROOT_COERCED] === undefined ? out : undefined;
}
