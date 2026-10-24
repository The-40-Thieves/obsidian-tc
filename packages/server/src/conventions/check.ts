// Check one note's frontmatter against its effective conventions. Pure: no I/O, no ACL. Problems are
// warnings for the caller to fix; nothing here blocks a write.

import { isGeneratedWikiPath, rawPathFilter } from "../tools/m7/knowledge/wiki-folder";
import { WIKI_SCHEMA_FILE } from "../tools/m7/knowledge/wiki-schema";
import { MAX_SCAN_WARNINGS } from "../tools/scan-warnings";
import { fmHas } from "../tools/wiki-scan";
import type { Frontmatter } from "../vault/frontmatter";
import { frontmatterTags, normalizeTag, tagMatches } from "../vault/tags";
import { scalarText } from "./parse";
import type {
  ConventionWarning,
  EffectiveConventions,
  EffectiveTypeRules,
  Severity,
  SourcedValues,
} from "./schema";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The level a violation of `prop` reports at: the first of types[t].severity[prop], severity[prop],
 *  types[t].severity["*"], severity["*"] that is set, else warn. `prop` is looked up under its alias
 *  too (tags/tag, aliases/alias), as the rule itself is. */
function severityOf(
  eff: EffectiveConventions,
  typeRules: EffectiveTypeRules | undefined,
  prop: string,
): Severity {
  const at = (sev: Record<string, { value: Severity }> | undefined): Severity | undefined =>
    fieldKeys(prop)
      .map((k) => sev?.[k]?.value)
      .find((v) => v !== undefined);
  return (
    at(typeRules?.severity) ??
    at(eff.severity) ??
    typeRules?.severity["*"]?.value ??
    eff.severity["*"]?.value ??
    "warn"
  );
}

const notAllowedMessage = (prop: string, bad: string[], allowed: string[]): string =>
  `\`${prop}\` has ${bad.map((b) => `"${b}"`).join(", ")}; allowed: ${allowed.join(", ")}`;

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

/** A tag as the tag rules match it: NFC, normalised, lower-case. */
const tagKey = (tag: string): string => normalizeTag(tag.normalize("NFC")).toLowerCase();

const isTagProp = (prop: string | undefined): boolean => prop === "tags" || prop === "tag";

/** Tag rules: `x` matches exactly, `x/*` matches any tag nested under x but not x itself; rules and
 *  tags are normalised like the vault's tags (`#` and trailing slashes dropped), case-insensitive. */
function tagAllowed(tag: string, allowed: string[]): boolean {
  const t = tagKey(tag);
  return allowed.some((a) => {
    const p = normalizeTag(a).toLowerCase();
    if (p.endsWith("/*")) {
      const base = p.slice(0, -2);
      return base !== "" && t !== base && tagMatches(base, t);
    }
    return t === p;
  });
}

/** The frontmatter keys a rule on `prop` reads: the plural and singular forms are one field. */
function fieldKeys(prop: string): string[] {
  if (prop === "tags" || prop === "tag") return ["tags", "tag"];
  if (prop === "aliases" || prop === "alias") return ["aliases", "alias"];
  return [prop];
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

/** True when `checkNote` judges this path: the effective set has rules and the path is not skipped. A type
 *  that sets only severity is not a rule: it changes how a violation is levelled, never whether one exists. */
export function judges(eff: EffectiveConventions, path: string): boolean {
  const hasRules =
    eff.required !== undefined ||
    Object.keys(eff.values).length > 0 ||
    Object.values(eff.types).some(
      (t) => t.required !== undefined || Object.keys(t.values).length > 0,
    );
  return hasRules && !skipped(eff, path);
}

/** Warnings for one note. An effective set with no rules, or a skipped path, yields none. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pre-existing (score 52); split when next modified
export function checkNote(
  eff: EffectiveConventions,
  path: string,
  fm: Frontmatter | null,
): ConventionWarning[] {
  if (!judges(eff, path)) return [];
  const out: ConventionWarning[] = [];
  const raw = fm?.[eff.typeKey];
  const { type, several } = pageType(raw);
  const typeRules: EffectiveTypeRules | undefined =
    type !== undefined ? eff.types[type] : undefined;
  const warn = (w: Omit<ConventionWarning, "path" | "level">): void => {
    out.push({ path, level: severityOf(eff, typeRules, w.property ?? ""), ...w });
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
      const keys = fieldKeys(prop).filter((k) => Object.hasOwn(fm, k));
      if (!rule || keys.length === 0) continue;
      const isTags = isTagProp(prop);
      const texts: string[] = [];
      if (isTags) {
        texts.push(...frontmatterTags(fm));
      } else {
        const items = keys.flatMap((k) => {
          const value = fm[k];
          return Array.isArray(value) ? value : [value];
        });
        // A non-scalar item is reported, and the scalar items beside it are still judged: a fix that
        // removes only the map item must not reveal a bad value the before-note already had.
        if (items.some((x) => isRecord(x) || Array.isArray(x)))
          warn({
            code: "value_not_scalar",
            property: prop,
            message: `\`${prop}\` must be text, a number or a boolean`,
            source: rule.source,
            ...typeLabel,
          });
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
          message: notAllowedMessage(prop, bad, rule.values),
          values: bad,
          allowed: rule.values.slice(0, MAX_SCAN_WARNINGS),
          source: rule.source,
          ...typeLabel,
        });
    }
  }
  return out;
}

/** The whole allowed list a warning's property is judged against. `w.allowed` is capped at the scan limit,
 *  so a message rebuilt from it would name fewer values than the rule holds. */
function allowedOf(eff: EffectiveConventions, w: ConventionWarning): string[] {
  const prop = w.property ?? "";
  const typeRules = w.type !== undefined ? eff.types[w.type] : undefined;
  return typeRules?.values[prop]?.values ?? eff.values[prop]?.values ?? w.allowed ?? [];
}

/** The values a warning names, one per key: value_not_allowed names several, the others one. */
const valuesOf = (w: ConventionWarning): string[] =>
  w.code === "value_not_allowed" ? (w.values ?? []) : [""];

/** Identity of a violation for the write check: (code, property, value). The type is not part of it: a
 *  type change must not relabel a violation that was already there. */
const keyOf = (w: ConventionWarning, value: string): string =>
  [w.code, w.property ?? "", isTagProp(w.property) ? tagKey(value) : value].join("\u0000");

/**
 * The blocking violations a write ADDS to a note: those `afterFm` has at level block that `beforeFm`
 * does not. Keyed per offending value, so a second bad value on a property that already had one
 * counts. `undefined` beforeFm is a new note (every blocking violation counts); `null` is a note whose
 * YAML is broken, judged as checkNote(eff, path, null). A partial fix, or an edit that adds nothing,
 * returns none. Pure: nothing calls it yet (the write gate is a later PR).
 */
export function blockingDelta(
  eff: EffectiveConventions,
  path: string,
  beforeFm: Frontmatter | null | undefined,
  afterFm: Frontmatter | null,
): ConventionWarning[] {
  const blocking = (fm: Frontmatter | null) =>
    checkNote(eff, path, fm).filter((w) => w.level === "block");
  const after = blocking(afterFm);
  if (beforeFm === undefined) return after;
  const before = new Set(blocking(beforeFm).flatMap((w) => valuesOf(w).map((v) => keyOf(w, v))));
  const out: ConventionWarning[] = [];
  for (const w of after) {
    const all = valuesOf(w);
    const fresh = all.filter((v) => !before.has(keyOf(w, v)));
    if (fresh.length === 0) continue;
    if (fresh.length === all.length) out.push(w);
    else
      out.push({
        ...w,
        values: fresh,
        message: notAllowedMessage(w.property ?? "", fresh, allowedOf(eff, w)),
      });
  }
  return out;
}
