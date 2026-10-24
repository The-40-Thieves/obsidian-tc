// Check one note's frontmatter against its effective conventions. Pure: no I/O, no ACL. Problems are
// warnings for the caller to fix; nothing here blocks a write.

import { isGeneratedWikiPath, rawPathFilter } from "../tools/m7/knowledge/wiki-folder";
import { WIKI_SCHEMA_FILE } from "../tools/m7/knowledge/wiki-schema";
import { MAX_SCAN_WARNINGS } from "../tools/scan-warnings";
import { fmHas } from "../tools/wiki-scan";
import type { Frontmatter } from "../vault/frontmatter";
import { frontmatterTags } from "../vault/tags";
import { scalarText } from "./parse";
import type {
  ConventionWarning,
  EffectiveConventions,
  EffectiveTypeRules,
  SourcedValues,
} from "./schema";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The `warnings` / `warnings_omitted` keys for a list of warnings (absent when there are none). */
export function capConventionWarnings<T>(items: readonly T[]): {
  warnings?: T[];
  warnings_omitted?: number;
} {
  return {
    ...(items.length > 0 ? { warnings: items.slice(0, MAX_SCAN_WARNINGS) } : {}),
    ...(items.length > MAX_SCAN_WARNINGS
      ? { warnings_omitted: items.length - MAX_SCAN_WARNINGS }
      : {}),
  };
}

/** Notes the checks never judge: the schema files themselves, non-Markdown, dot-folders, the wiki's
 *  generated index/log pages and the raw-sources folder. */
function skipped(eff: EffectiveConventions, path: string): boolean {
  if (!path.endsWith(".md")) return true;
  const parts = path.split("/");
  if (parts.some((p) => p.startsWith("."))) return true;
  if (parts[parts.length - 1] === WIKI_SCHEMA_FILE) return true;
  if (isGeneratedWikiPath(path, eff.wikiFolders)) return true;
  return rawPathFilter(eff.rawFolders)(path);
}

/** Tag rules: `x` matches exactly, `x/*` matches any tag nested under x; case-insensitive. */
function tagAllowed(tag: string, allowed: string[]): boolean {
  const t = tag.normalize("NFC").toLowerCase();
  return allowed.some((a) => {
    const p = a.normalize("NFC").toLowerCase();
    if (p.endsWith("/*")) {
      const base = p.slice(0, -2);
      return base !== "" && t.startsWith(`${base}/`);
    }
    return t === p;
  });
}

/** The page's type: a scalar, or a one-element list of one. Several types: undefined, flagged by the caller. */
function pageType(raw: unknown): { type?: string; several: boolean } {
  if (Array.isArray(raw))
    return raw.length === 1
      ? { type: scalarText(raw[0]), several: false }
      : { several: raw.length > 1 };
  if (isRecord(raw)) return { several: false };
  return { type: scalarText(raw), several: false };
}

/** Warnings for one note. An effective set with no rules, or a skipped path, yields none. */
export function checkNote(
  eff: EffectiveConventions,
  path: string,
  fm: Frontmatter | null,
): ConventionWarning[] {
  const hasRules =
    eff.required !== undefined ||
    Object.keys(eff.values).length > 0 ||
    Object.keys(eff.types).length > 0;
  if (!hasRules || skipped(eff, path)) return [];
  const out: ConventionWarning[] = [];
  const raw = fm?.[eff.typeKey];
  const { type, several } = pageType(raw);
  const typeRules: EffectiveTypeRules | undefined =
    type !== undefined ? eff.types[type] : undefined;
  const warn = (w: Omit<ConventionWarning, "path" | "level">): void => {
    out.push({ path, level: "warn", ...w });
  };
  const typeLabel = type !== undefined ? { type } : {};

  if (several)
    warn({
      code: "type_not_scalar",
      property: eff.typeKey,
      message: `\`${eff.typeKey}\` lists several types; only the global rules apply`,
      source: eff.typeKeySource,
    });
  else if (isRecord(raw) || (Array.isArray(raw) && raw.length === 1 && isRecord(raw[0])))
    warn({
      code: "type_not_scalar",
      property: eff.typeKey,
      message: `\`${eff.typeKey}\` must be a single type name`,
      source: eff.typeKeySource,
    });

  const required: { field: string; source: string }[] = [];
  if (eff.required)
    for (const field of eff.required.values) required.push({ field, source: eff.required.source });
  const typeRequired: SourcedValues | undefined = typeRules?.required;
  if (typeRequired)
    for (const field of typeRequired.values) required.push({ field, source: typeRequired.source });
  const seen = new Set<string>();
  for (const { field, source } of required) {
    if (seen.has(field)) continue;
    seen.add(field);
    if (!fmHas(fm, field))
      warn({
        code: "missing_required",
        property: field,
        message: `\`${field}\` is required${type !== undefined ? ` for type "${type}"` : ""}`,
        source,
        ...typeLabel,
      });
  }

  if (fm) {
    const props = new Set([...Object.keys(eff.values), ...Object.keys(typeRules?.values ?? {})]);
    for (const prop of props) {
      const rule: SourcedValues | undefined = typeRules?.values[prop] ?? eff.values[prop];
      if (!rule || !Object.hasOwn(fm, prop)) continue;
      const isTags = prop === "tags" || prop === "tag";
      const texts: string[] = [];
      if (isTags) {
        texts.push(...frontmatterTags(fm));
      } else {
        const value = fm[prop];
        const items = Array.isArray(value) ? value : [value];
        if (items.some((x) => isRecord(x) || Array.isArray(x))) {
          warn({
            code: "value_not_scalar",
            property: prop,
            message: `\`${prop}\` must be text, a number or a boolean`,
            source: rule.source,
            ...typeLabel,
          });
          continue;
        }
        for (const x of items) {
          const s = scalarText(x);
          if (s !== undefined) texts.push(s);
        }
      }
      const bad = isTags
        ? texts.filter((t) => !tagAllowed(t, rule.values))
        : texts.filter((t) => !rule.values.includes(t));
      if (bad.length > 0)
        warn({
          code: "value_not_allowed",
          property: prop,
          message: `\`${prop}\` has ${bad.map((b) => `"${b}"`).join(", ")}; allowed: ${rule.values.join(", ")}`,
          values: bad,
          allowed: rule.values.slice(0, MAX_SCAN_WARNINGS),
          source: rule.source,
          ...typeLabel,
        });
    }
  }
  return out;
}
