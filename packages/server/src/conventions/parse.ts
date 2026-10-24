// Parse one SCHEMA.md layer's `conventions:` block. Never throws: a bad block is a warning and no
// layer, a bad entry is dropped with a warning and the rest of the block still counts.
import { SCHEMA_LIMITS } from "../tools/m7/knowledge/wiki-schema";
import { MAX_SCAN_WARNINGS } from "../tools/scan-warnings";
import { parseNoteLenient } from "../vault/frontmatter";
import {
  CONVENTIONS_KEY,
  CONVENTIONS_VERSION,
  type ConventionsLayer,
  type ConventionsTypeLayer,
  type ParsedConventionsLayer,
} from "./schema";

const KNOWN_TOP = new Set(["version", "inherit", "frontmatter"]);
const KNOWN_FRONTMATTER = new Set(["type_key", "required", "values", "types"]);
const KNOWN_TYPE = new Set(["required", "values"]);
/** Top-level keys of the legacy wiki schema (commit_wiki_page only). */
const LEGACY_KEYS = ["types", "properties"];
export const LEGACY_HINT =
  "types/properties apply only to commit_wiki_page in the wiki folder; add a conventions: block";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A map with no prototype, so no property name collides with an inherited one. */
const nullMap = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

/** Text for a value: a string, number or boolean, trimmed and NFC-normalised; else undefined. */
export function scalarText(v: unknown): string | undefined {
  const s =
    typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : null;
  const t = s?.trim().normalize("NFC") ?? "";
  return t === "" ? undefined : t;
}

/** A list of scalar values (a lone scalar is a list of one). Absent: undefined. null: an explicit
 *  empty list, which is a removal marker. Bad entries are dropped with a warning. */
function textList(
  v: unknown,
  where: string,
  warnings: string[],
  max: number,
): string[] | undefined {
  if (v === undefined) return undefined;
  if (v === null) return [];
  if (isRecord(v)) {
    warnings.push(`${where} must be a list of values; ignored`);
    return undefined;
  }
  const items = Array.isArray(v) ? v : [v];
  // A literal empty list is the removal marker; a non-empty list is never one (see below).
  if (items.length === 0) return [];
  if (items.length > max) warnings.push(`${where}: only the first ${max} entries were read`);
  const out = new Set<string>();
  for (const item of items.slice(0, max)) {
    if (typeof item === "object" && item !== null) {
      warnings.push(`${where}: dropped a value that is not text, a number or a boolean`);
      continue;
    }
    const s = scalarText(item);
    if (s === undefined) {
      warnings.push(`${where}: ignored an empty value`);
      continue;
    }
    if (s.length > SCHEMA_LIMITS.textChars) {
      warnings.push(`${where}: ignored a value longer than ${SCHEMA_LIMITS.textChars} characters`);
      continue;
    }
    out.add(s);
  }
  // Every entry was dropped: the list sets no rule, so an inherited rule stays (undefined, not []).
  return out.size > 0 ? [...out] : undefined;
}

function parseValues(
  raw: unknown,
  where: string,
  out: Record<string, string[]>,
  warnings: string[],
): void {
  if (raw === undefined || raw === null) return;
  if (!isRecord(raw)) {
    warnings.push(`${where} must be a map of property -> allowed values; ignored`);
    return;
  }
  const entries = Object.entries(raw);
  if (entries.length > SCHEMA_LIMITS.properties)
    warnings.push(`${where}: only the first ${SCHEMA_LIMITS.properties} properties were read`);
  for (const [name, list] of entries.slice(0, SCHEMA_LIMITS.properties)) {
    if (name.length > SCHEMA_LIMITS.textChars) {
      warnings.push(
        `${where}: ignored a property name longer than ${SCHEMA_LIMITS.textChars} characters`,
      );
      continue;
    }
    const values = textList(list, `${where}.${name}`, warnings, SCHEMA_LIMITS.valuesPerProperty);
    if (values !== undefined) out[name] = values;
  }
}

function parseTypes(raw: unknown, layer: ConventionsLayer, warnings: string[]): void {
  if (raw === undefined || raw === null) return;
  if (!isRecord(raw)) {
    warnings.push("`frontmatter.types` must be a map of type name -> rules; ignored");
    return;
  }
  const entries = Object.entries(raw);
  if (entries.length > SCHEMA_LIMITS.types)
    warnings.push(`\`frontmatter.types\`: only the first ${SCHEMA_LIMITS.types} types were read`);
  for (const [rawName, def] of entries.slice(0, SCHEMA_LIMITS.types)) {
    const name = scalarText(rawName);
    if (name === undefined) {
      warnings.push("`frontmatter.types`: ignored a type name that is empty");
      continue;
    }
    if (name.length > SCHEMA_LIMITS.textChars) {
      warnings.push(
        `\`frontmatter.types\`: ignored a type name longer than ${SCHEMA_LIMITS.textChars} characters`,
      );
      continue;
    }
    if (def === undefined || def === null) continue;
    if (!isRecord(def)) {
      warnings.push(`type "${name}": the rules must be a map; ignored`);
      continue;
    }
    for (const key of Object.keys(def))
      if (!KNOWN_TYPE.has(key))
        warnings.push(`type "${name}": \`${key}\` is not supported yet; ignored`);
    const t: ConventionsTypeLayer = { values: nullMap() };
    const required = textList(
      def.required,
      `type "${name}" required`,
      warnings,
      SCHEMA_LIMITS.fieldsPerType,
    );
    if (required !== undefined) t.required = required;
    parseValues(def.values, `type "${name}" values`, t.values, warnings);
    layer.types[name] = t;
  }
}

/** Parse one SCHEMA.md's text. `path` is recorded on the layer and is diagnostic-only. Warnings are
 *  capped at the scan cap, so a cached layer stays small whatever the file holds. */
export function parseConventionsLayer(text: string, path: string): ParsedConventionsLayer {
  const parsed = parseLayer(text, path);
  if (parsed.warnings.length <= MAX_SCAN_WARNINGS) return parsed;
  return {
    ...parsed,
    warnings: parsed.warnings.slice(0, MAX_SCAN_WARNINGS),
    warningsOmitted: parsed.warnings.length - MAX_SCAN_WARNINGS,
  };
}

function parseLayer(text: string, path: string): ParsedConventionsLayer {
  const none = (warnings: string[] = [], legacyOnly = false): ParsedConventionsLayer => ({
    layer: null,
    warnings,
    legacyOnly,
  });
  if (Buffer.byteLength(text, "utf8") > SCHEMA_LIMITS.fileBytes)
    return none([`conventions not read: the file is larger than ${SCHEMA_LIMITS.fileBytes} bytes`]);
  const note = parseNoteLenient(text, path);
  if (note.yamlError) return none([`conventions not read: ${note.yamlError.message}`]);
  const fm = note.frontmatter;
  if (!note.hasFrontmatter || fm === null) return none();
  if (!Object.hasOwn(fm, CONVENTIONS_KEY))
    return none(
      [],
      LEGACY_KEYS.some((k) => Object.hasOwn(fm, k)),
    );
  const block = fm[CONVENTIONS_KEY];
  if (!isRecord(block)) return none(["`conventions` must be a map; ignored"]);

  const warnings: string[] = [];
  for (const key of Object.keys(block))
    if (!KNOWN_TOP.has(key)) warnings.push(`\`conventions.${key}\` is not supported yet; ignored`);
  const version = block.version === undefined ? 1 : block.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1)
    return none([
      ...warnings,
      "`conventions.version` must be a whole number; the layer is ignored",
    ]);
  if (version > CONVENTIONS_VERSION)
    return none([
      ...warnings,
      `written for conventions version ${version}; this server reads version ${CONVENTIONS_VERSION}, so the layer is ignored`,
    ]);
  if (block.inherit !== undefined && typeof block.inherit !== "boolean")
    warnings.push("`conventions.inherit` must be true or false; read as true");

  const layer: ConventionsLayer = {
    path,
    version,
    inherit: typeof block.inherit === "boolean" ? block.inherit : true,
    values: nullMap(),
    types: nullMap(),
  };
  const frontmatter = block.frontmatter;
  if (frontmatter !== undefined && frontmatter !== null && !isRecord(frontmatter)) {
    warnings.push("`conventions.frontmatter` must be a map; ignored");
  } else if (isRecord(frontmatter)) {
    for (const key of Object.keys(frontmatter))
      if (!KNOWN_FRONTMATTER.has(key))
        warnings.push(`\`conventions.frontmatter.${key}\` is not supported yet; ignored`);
    if (frontmatter.type_key !== undefined) {
      const key = scalarText(frontmatter.type_key);
      if (key === undefined)
        warnings.push("`conventions.frontmatter.type_key` must be text; ignored");
      else layer.typeKey = key;
    }
    const required = textList(
      frontmatter.required,
      "`conventions.frontmatter.required`",
      warnings,
      SCHEMA_LIMITS.fieldsPerType,
    );
    if (required !== undefined) layer.required = required;
    parseValues(frontmatter.values, "`conventions.frontmatter.values`", layer.values, warnings);
    parseTypes(frontmatter.types, layer, warnings);
  }
  return { layer, warnings, legacyOnly: false };
}
