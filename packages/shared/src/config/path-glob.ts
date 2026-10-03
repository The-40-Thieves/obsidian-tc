// The ONE parse point for an operator-written vault-path glob in the config file. Leaf module:
// imports Zod only, so every schema that holds such a field can use it (same import rule as the
// other config/*.schema.ts leaves).
//
// WHY: a checked vault path is always forward-slash (normalizeVaultPath splits on [\\/]+), but a
// glob was only NFC-normalised before compiling. `Private\**` — the natural spelling on Windows —
// therefore compiled to a regex that no vault path can match. For a whitelist
// (acl.readPaths/writePaths/deletePaths) that fails closed, which is safe; for a RESTRICTION
// (egress.excludePaths, acl.rules, vaults[].index.excludePaths) it fails OPEN and says so nowhere.
// Normalising here, once, at config load means the compilers downstream (acl.ts's globToRegExp, the
// egress filter, the index-exclusion matcher) only ever see forward-slash input.
//
// A vault path can never contain a backslash (normalizeVaultPath treats it as a separator), so
// there is no escaping use case to preserve in OPERATOR input: `\` is always a separator here. This
// is unrelated to the escaping the server applies to globs it BUILDS itself (acl.ts escapeGlob),
// which never passes through config parsing.
import { z } from "zod";

/** Backslash -> slash, then repeated separators collapse. Nothing else: no trimming (a folder may
 *  legitimately carry surrounding whitespace), no case folding, no leading `./` or `/` handling
 *  (egress.excludePaths does its own, in normalizeEgressExcludePattern). */
function normalizeConfigPathGlob(glob: string): string {
  return glob.replace(/[\\/]+/g, "/");
}

/** An operator path glob: a string normalised by `normalizeConfigPathGlob` at parse time.
 *  `.overwrite` (not `.transform`) so the schema stays a plain ZodString: the generated JSON schema
 *  and the docgen walker both still see `string`, and further `.min`/`.refine` checks chain on. */
export const configPathGlob = () => z.string().overwrite(normalizeConfigPathGlob);

/** Obsidian's Excluded-files dialect (vaults[].index.excludePaths): `/regex/` is a regular
 *  expression, anything else a case-insensitive path prefix. The shape test is shared with the
 *  matcher (server's search/index-exclusion.ts) so the two cannot disagree on which entries are
 *  regexes. */
export function isRegexExclusionEntry(entry: string): boolean {
  return entry.length > 2 && entry.startsWith("/") && entry.endsWith("/");
}

/** One Obsidian-dialect exclusion entry. A `/regex/` entry is left exactly as written (a backslash
 *  there is a regex escape). A prefix entry is normalised like any path glob, and a leading
 *  separator is dropped: prefixes are matched against vault-relative paths, and a leading `/` that
 *  came from `\Old\` must not turn the entry into a regex-shaped `/Old/`. */
function normalizeIndexExclusionEntry(entry: string): string {
  if (isRegexExclusionEntry(entry.trim())) return entry;
  return normalizeConfigPathGlob(entry).replace(/^\/+/, "");
}

export const indexExclusionEntry = () => z.string().overwrite(normalizeIndexExclusionEntry);
