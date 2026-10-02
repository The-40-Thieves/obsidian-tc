// SCHEMA.md: the wiki folder's own statement of what a page is. It lives in the configured wiki
// folder (`vaults[].wiki.folder`) and declares, in its frontmatter,
//   types:       page types, each with the frontmatter fields it REQUIRES (and an optional
//                `description` and `folder`, the subfolder new pages of that type go in);
//   properties:  the allowed property vocabulary, either a list of names or a map of name -> the
//                values allowed for it (an empty value means any), which is what stops the
//                taxonomy drifting (`tag`, `tags`, `Tags`...).
// The body is free prose for humans and is never parsed.
//
// Parsing never throws and never blocks a write: whatever cannot be read becomes a warning, and the
// rest of the file still counts. Checking a page against it yields PROBLEMS for the calling LLM to
// fix, never an error. The note is read as an ordinary vault file under the read ACL (denied ==
// missing).
import { enforcePathAcl } from "../../../vault/acl-path";
import { readableRel } from "../../../vault/acl-read-filter";
import { parseNoteLenient } from "../../../vault/frontmatter";
import { noteExists, readNoteBounded } from "../../../vault/notes-io";
import { resolveVaultPath } from "../../../vault/paths";
import { fmHas, type ScanScope } from "../../wiki-scan";

export const WIKI_SCHEMA_FILE = "SCHEMA.md";

/** The frontmatter property that names a page's type. */
export const WIKI_TYPE_KEY = "type";

/** SCHEMA.md is read synchronously and expanded into every draft response, so it is bounded: a file
 *  over the byte cap is not read at all, and a section over a count or length cap is cut with a
 *  warning (the rest of the file still counts). Real schemas are a few KiB. */
export const SCHEMA_LIMITS = {
  fileBytes: 64 * 1024,
  types: 100,
  fieldsPerType: 100,
  properties: 500,
  valuesPerProperty: 200,
  textChars: 200,
  descriptionChars: 500,
} as const;

/** Obsidian's own properties: always allowed, whatever vocabulary the schema declares. */
const BUILTIN_PROPERTIES: ReadonlySet<string> = new Set(["tags", "aliases", "cssclasses"]);

export interface WikiPageType {
  name: string;
  description?: string;
  /** Frontmatter fields a page of this type must carry (non-empty). */
  required: string[];
  /** Subfolder of the wiki folder new pages of this type are proposed in. */
  folder?: string;
}

export interface WikiSchema {
  types: WikiPageType[];
  /** Allowed property -> allowed values (`null`: any value). `null`: no vocabulary declared. A
   *  null-prototype object: a property named `toString` or `__proto__` is a name like any other, so
   *  read it with `Object.hasOwn`, never by plain lookup. */
  vocabulary: Record<string, string[] | null> | null;
}

export interface WikiSchemaLoad {
  /** Vault path SCHEMA.md would be (or was) read from. */
  path: string;
  found: boolean;
  schema: WikiSchema | null;
  warnings: string[];
}

export interface SchemaProblem {
  code: "missing_type" | "unknown_type" | "missing_required" | "unknown_property" | "bad_value";
  field?: string;
  message: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const scalar = (v: unknown): string | undefined =>
  typeof v === "string" ? v.trim() || undefined : typeof v === "number" ? String(v) : undefined;

/** `s` when it fits `max` characters; otherwise a warning and undefined. */
function fitting(s: string, max: number, where: string, warnings: string[]): string | undefined {
  if (s.length <= max) return s;
  warnings.push(`${where}: ignored a value longer than ${max} characters`);
  return undefined;
}

/** A list of strings (a lone string is a list of one); bad entries are dropped and reported, and
 *  entries past `max` are cut with one warning. */
function stringList(
  v: unknown,
  where: string,
  warnings: string[],
  max: number = SCHEMA_LIMITS.fieldsPerType,
): string[] {
  if (v === undefined || v === null) return [];
  const items = Array.isArray(v) ? v : [v];
  if (items.length > max) warnings.push(`${where}: only the first ${max} entries were read`);
  const out: string[] = [];
  for (const item of items.slice(0, max)) {
    const raw = scalar(item);
    if (raw === undefined) warnings.push(`${where}: ignored a value that is not text`);
    else {
      const s = fitting(raw, SCHEMA_LIMITS.textChars, where, warnings);
      if (s !== undefined) out.push(s);
    }
  }
  return out;
}

function parseTypes(raw: unknown, warnings: string[]): WikiPageType[] {
  if (raw === undefined || raw === null) return [];
  if (!isRecord(raw)) {
    warnings.push("`types` must be a map of type name -> definition; no page types were read");
    return [];
  }
  const out: WikiPageType[] = [];
  const entries = Object.entries(raw);
  if (entries.length > SCHEMA_LIMITS.types)
    warnings.push(`\`types\`: only the first ${SCHEMA_LIMITS.types} types were read`);
  for (const [name, def] of entries.slice(0, SCHEMA_LIMITS.types)) {
    if (name.length > SCHEMA_LIMITS.textChars) {
      warnings.push(
        `\`types\`: ignored a type name longer than ${SCHEMA_LIMITS.textChars} characters`,
      );
      continue;
    }
    if (def !== null && def !== undefined && !isRecord(def)) {
      warnings.push(`type "${name}": the definition must be a map; treated as having no fields`);
    }
    const d = isRecord(def) ? def : {};
    const rawDescription = scalar(d.description);
    const description =
      rawDescription === undefined
        ? undefined
        : fitting(
            rawDescription,
            SCHEMA_LIMITS.descriptionChars,
            `type "${name}" description`,
            warnings,
          );
    const folder = scalar(d.folder)
      ?.slice(0, SCHEMA_LIMITS.textChars)
      .replace(/\\/g, "/")
      .split("/")
      .filter((p) => p !== "" && p !== "." && p !== "..")
      .join("/");
    out.push({
      name,
      required: [...new Set(stringList(d.required, `type "${name}" required`, warnings))],
      ...(description ? { description } : {}),
      ...(folder ? { folder } : {}),
    });
  }
  return out;
}

/** A map with no prototype, so no property name collides with an inherited one. */
function vocabularyMap(): Record<string, string[] | null> {
  return Object.create(null) as Record<string, string[] | null>;
}

function parseVocabulary(raw: unknown, warnings: string[]): WikiSchema["vocabulary"] {
  if (raw === undefined || raw === null) return null;
  if (Array.isArray(raw)) {
    const out = vocabularyMap();
    for (const n of stringList(raw, "properties", warnings, SCHEMA_LIMITS.properties))
      out[n] = null;
    return out;
  }
  if (!isRecord(raw)) {
    warnings.push(
      "`properties` must be a list of names or a map of name -> allowed values; ignored",
    );
    return null;
  }
  const out = vocabularyMap();
  const entries = Object.entries(raw);
  if (entries.length > SCHEMA_LIMITS.properties)
    warnings.push(
      `\`properties\`: only the first ${SCHEMA_LIMITS.properties} properties were read`,
    );
  for (const [name, values] of entries.slice(0, SCHEMA_LIMITS.properties)) {
    if (name.length > SCHEMA_LIMITS.textChars) {
      warnings.push(
        `\`properties\`: ignored a property name longer than ${SCHEMA_LIMITS.textChars} characters`,
      );
      continue;
    }
    const list = stringList(
      values,
      `property "${name}"`,
      warnings,
      SCHEMA_LIMITS.valuesPerProperty,
    );
    out[name] = list.length > 0 ? list : null;
  }
  return out;
}

/** Parse SCHEMA.md's text. Never throws: a malformed file is a warning and a null schema (bad YAML)
 *  or a partial one (a bad section is skipped, the rest is kept). */
export function parseWikiSchema(raw: string, path: string): WikiSchemaLoad {
  const warnings: string[] = [];
  if (Buffer.byteLength(raw, "utf8") > SCHEMA_LIMITS.fileBytes)
    return {
      path,
      found: true,
      schema: null,
      warnings: [`${path} was not read: it is larger than ${SCHEMA_LIMITS.fileBytes} bytes`],
    };
  const note = parseNoteLenient(raw, path);
  if (note.yamlError) {
    return {
      path,
      found: true,
      schema: null,
      warnings: [`${path} was not read: ${note.yamlError.message}`],
    };
  }
  const fm = note.frontmatter;
  if (!note.hasFrontmatter || fm === null) {
    return {
      path,
      found: true,
      schema: null,
      warnings: [`${path} has no frontmatter block, so it declares no page types or properties`],
    };
  }
  const schema: WikiSchema = {
    types: parseTypes(fm.types, warnings),
    vocabulary: parseVocabulary(fm.properties, warnings),
  };
  if (schema.types.length === 0 && schema.vocabulary === null)
    warnings.push(`${path} declares neither \`types\` nor \`properties\`; nothing is enforced`);
  return { path, found: true, schema, warnings };
}

/** Read and parse `<folder>/SCHEMA.md`. A missing or unreadable file is `found: false`, not an error. */
export function loadWikiSchema(scope: ScanScope, folder: string | undefined): WikiSchemaLoad {
  const path = folder ? `${folder}/${WIKI_SCHEMA_FILE}` : WIKI_SCHEMA_FILE;
  if (!folder || !readableRel(scope.acl, path, scope.grantedScopes))
    return { path, found: false, schema: null, warnings: [] };
  // The read ACL is enforced on the REAL path, not just the name: SCHEMA.md may be a symlink to a
  // note the caller cannot read. Denied (or a link out of the vault) == missing.
  try {
    enforcePathAcl(scope.acl, "read", path, scope.root, scope.grantedScopes);
  } catch {
    return { path, found: false, schema: null, warnings: [] };
  }
  try {
    const abs = resolveVaultPath(scope.root, path);
    if (noteExists(abs).type !== "file") return { path, found: false, schema: null, warnings: [] };
    // Read with a ceiling, not stat-then-read: a file that grows after a size check is still cut off.
    const { raw } = readNoteBounded(abs, SCHEMA_LIMITS.fileBytes);
    if (raw === null)
      return {
        path,
        found: true,
        schema: null,
        warnings: [`${path} was not read: it is larger than ${SCHEMA_LIMITS.fileBytes} bytes`],
      };
    return parseWikiSchema(raw, path);
  } catch (e) {
    return {
      path,
      found: true,
      schema: null,
      warnings: [`${path} could not be read: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
}

const valueText = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [v]).flatMap((x) => {
    const s = scalar(x);
    return s === undefined ? [] : [s];
  });

/**
 * Check a page's frontmatter against the schema. `typeName` overrides the page's own `type`
 * property (the type a caller asked for). Returns problems for the caller to fix; an absent schema
 * is no problems at all.
 */
export function checkFrontmatter(
  schema: WikiSchema | null,
  fm: Record<string, unknown> | null,
  typeName?: string,
): SchemaProblem[] {
  if (!schema) return [];
  const problems: SchemaProblem[] = [];
  const type = typeName ?? scalar(fm?.[WIKI_TYPE_KEY]);
  if (schema.types.length > 0) {
    const names = schema.types.map((t) => t.name).join(", ");
    const def = schema.types.find((t) => t.name === type);
    if (!type)
      problems.push({
        code: "missing_type",
        field: WIKI_TYPE_KEY,
        message: `set \`${WIKI_TYPE_KEY}\` to one of: ${names}`,
      });
    else if (!def)
      problems.push({
        code: "unknown_type",
        field: WIKI_TYPE_KEY,
        message: `type "${type}" is not declared in SCHEMA.md; use one of: ${names}`,
      });
    else
      for (const field of def.required)
        if (!fmHas(fm, field))
          problems.push({
            code: "missing_required",
            field,
            message: `type "${def.name}" requires \`${field}\``,
          });
  }
  if (schema.vocabulary && fm) {
    const vocabulary = schema.vocabulary;
    for (const [key, value] of Object.entries(fm)) {
      if (BUILTIN_PROPERTIES.has(key.toLowerCase())) continue;
      const allowed = Object.hasOwn(vocabulary, key) ? vocabulary[key] : undefined;
      if (allowed === undefined) {
        const near = Object.keys(vocabulary).find((k) => k.toLowerCase() === key.toLowerCase());
        problems.push({
          code: "unknown_property",
          field: key,
          message: near
            ? `\`${key}\` is not in the property vocabulary; SCHEMA.md uses \`${near}\``
            : `\`${key}\` is not in the property vocabulary of SCHEMA.md`,
        });
      } else if (allowed !== null) {
        const bad = valueText(value).filter((v) => !allowed.includes(v));
        if (bad.length > 0)
          problems.push({
            code: "bad_value",
            field: key,
            message: `\`${key}\` has ${bad.map((b) => `"${b}"`).join(", ")}; allowed: ${allowed.join(", ")}`,
          });
      }
    }
  }
  return problems;
}
