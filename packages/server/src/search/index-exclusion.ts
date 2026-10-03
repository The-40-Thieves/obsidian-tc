// Index-level exclusion that mirrors Obsidian's Settings -> Files & links -> Excluded files
// (`userIgnoreFilters` in `<vault>/.obsidian/app.json`), merged with the optional per-vault
// `index.excludePaths`. See docs/design/search-indexing-and-cache.md and the "Excluded files" docs
// page.
//
// Pattern dialect, reproduced from Obsidian 1.13.7's metadata cache (`updateUserIgnoreFilters` /
// `isUserIgnored`) because the help site does not specify it:
//   - each entry is trimmed; an empty entry is ignored;
//   - an entry longer than 2 characters that starts AND ends with `/` is a regular expression
//     (the text between the slashes), compiled case-insensitively and tested UNANCHORED;
//   - any other entry is a literal path PREFIX (regex-escaped, anchored at the start, compiled
//     case-insensitively), so `Archive/` is a folder, `Notes/todo.md` a file, and a bare `Draft`
//     also matches `Drafts/x.md`;
//   - an entry that fails to compile is skipped (Obsidian logs "Bad regex for user ignore filter");
//   - the subject is the vault-relative, forward-slash path of the file.
// An excluded note stays an ordinary vault file for link resolution; only the index leaves it out.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRegexExclusionEntry } from "@the-40-thieves/obsidian-tc-shared";
import { OBSIDIAN_APP_CONFIG } from "../vault/watcher";

/** An app.json larger than this is not read (a real one is a few KB). */
const MAX_APP_CONFIG_BYTES = 1024 * 1024;
/** A regex entry longer than this is rejected rather than compiled. */
const MAX_PATTERN_CHARS = 1024;
// Same character set Obsidian escapes for a literal-prefix entry.
const escapeRegExp = (s: string): string => s.replace(/[.?*+^$[\]\\(){}|-]/g, "\\$&");

/** `resolution_reason` stamped on a contradiction row dismissed because its note became excluded. */
export const EXCLUDED_DISMISS_REASON =
  "note excluded from the index (Obsidian Excluded files or index.excludePaths)";

export interface VaultExclusion {
  /** Is this vault-relative path left out of the index? */
  isExcluded(rel: string): boolean;
  /** The effective list, Obsidian entries first then the configured ones, trimmed, empties dropped. */
  effective: readonly string[];
  /** The entries read from `.obsidian/app.json` (`userIgnoreFilters`). */
  obsidian: readonly string[];
  /** The entries from this vault's `index.excludePaths`. */
  config: readonly string[];
  /** Entries that could not be compiled and are therefore ignored. */
  invalid: readonly string[];
  /** Set when app.json exists but could not be read or parsed (the last good list is kept). */
  appConfigError?: string;
}

/** Nothing excluded. */
export const NO_EXCLUSION: VaultExclusion = {
  isExcluded: () => false,
  effective: [],
  obsidian: [],
  config: [],
  invalid: [],
};

const clean = (entries: readonly unknown[]): string[] =>
  entries.flatMap((e) => (typeof e === "string" && e.trim() !== "" ? [e.trim()] : []));

function compileEntry(entry: string): RegExp | null {
  if (entry.length > MAX_PATTERN_CHARS) return null;
  try {
    return isRegexExclusionEntry(entry)
      ? new RegExp(entry.slice(1, -1), "i")
      : new RegExp(`^${escapeRegExp(entry)}`, "i");
  } catch {
    return null;
  }
}

/** Compile entries (already trimmed) into a predicate; uncompilable ones are reported, not thrown. */
export function compileExclusionEntries(entries: readonly string[]): {
  test: (rel: string) => boolean;
  invalid: string[];
} {
  const matchers: RegExp[] = [];
  const invalid: string[] = [];
  for (const entry of entries) {
    const re = compileEntry(entry);
    if (re) matchers.push(re);
    else invalid.push(entry);
  }
  return {
    test: (rel) => matchers.some((re) => re.test(rel)),
    invalid,
  };
}

interface AppConfigRead {
  entries: string[];
  error?: string;
}

// Last good read per vault root, keyed by file size + mtime: re-reading is a stat per call, and a
// half-written app.json keeps the previous list rather than silently un-excluding every note.
const appConfigCache = new Map<
  string,
  { sig: string; read: AppConfigRead; lastGood: readonly string[] | undefined }
>();

function failedRead(
  root: string,
  sig: string,
  error: string,
  cached: (typeof appConfigCache extends Map<string, infer V> ? V : never) | undefined,
): AppConfigRead {
  if (cached?.sig === sig) return cached.read;
  const read = { entries: [...(cached?.lastGood ?? [])], error };
  appConfigCache.set(root, { sig, read, lastGood: cached?.lastGood });
  process.stderr.write(`[index] warning: ${error}; keeping the last-good exclusion list\n`);
  return read;
}

function readAppConfig(root: string): AppConfigRead {
  const file = join(root, OBSIDIAN_APP_CONFIG);
  let sig: string;
  try {
    const st = lstatSync(file);
    // A symlink or non-file is not read (same stance as the vault's own file reads).
    if (!st.isFile() || st.size > MAX_APP_CONFIG_BYTES) {
      return failedRead(
        root,
        `invalid:${st.mode}:${st.size}:${st.mtimeMs}`,
        "app.json is not a regular file of readable size",
        appConfigCache.get(root),
      );
    }
    sig = `${st.size}:${st.mtimeMs}`;
  } catch (e) {
    const cached = appConfigCache.get(root);
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && cached === undefined) return { entries: [] };
    return failedRead(
      root,
      code === "ENOENT" ? "missing" : `unreadable:${code ?? "unknown"}`,
      code === "ENOENT"
        ? "app.json became unavailable"
        : `app.json could not be inspected: ${e instanceof Error ? e.message : String(e)}`,
      cached,
    );
  }
  const cached = appConfigCache.get(root);
  if (cached?.sig === sig) return cached.read;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const raw =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { userIgnoreFilters?: unknown }).userIgnoreFilters
        : undefined;
    const read = { entries: Array.isArray(raw) ? clean(raw) : [] };
    appConfigCache.set(root, { sig, read, lastGood: read.entries });
    return read;
  } catch (e) {
    const error = `app.json could not be read: ${e instanceof Error ? e.message : String(e)}`;
    return failedRead(root, sig, error, cached);
  }
}

const compiledCache = new Map<string, ReturnType<typeof compileExclusionEntries>>();

/**
 * The vault's current exclusion: Obsidian's `userIgnoreFilters` (read fresh when app.json changed,
 * otherwise from the stat-keyed cache) merged with `configEntries` (`index.excludePaths`). Returns an
 * immutable snapshot, so a caller that holds one for a whole reconcile pass sees one consistent list.
 */
export function loadVaultExclusion(
  root: string,
  configEntries: readonly string[] = [],
): VaultExclusion {
  const app = readAppConfig(root);
  const config = clean(configEntries);
  if (app.entries.length === 0 && config.length === 0 && app.error === undefined)
    return NO_EXCLUSION;
  const effective = [...app.entries, ...config.filter((c) => !app.entries.includes(c))];
  const key = JSON.stringify(effective);
  let compiled = compiledCache.get(key);
  if (!compiled) {
    if (compiledCache.size > 64) compiledCache.clear();
    compiled = compileExclusionEntries(effective);
    compiledCache.set(key, compiled);
  }
  return {
    isExcluded: compiled.test,
    effective,
    obsidian: app.entries,
    config,
    invalid: compiled.invalid,
    ...(app.error !== undefined ? { appConfigError: app.error } : {}),
  };
}

/** The vault-resolving slice of `VaultRegistry` this module needs (keeps the dependency one-way). */
export interface ExclusionVaultLookup {
  resolve(vault?: string | null): { root: string; indexExcludePaths?: readonly string[] };
}

/** Per-vault exclusion snapshot for `vaultId`, resolved through the registry. */
export function vaultExclusionFor(lookup: ExclusionVaultLookup, vaultId: string): VaultExclusion {
  const v = lookup.resolve(vaultId);
  return loadVaultExclusion(v.root, v.indexExcludePaths ?? []);
}

/** Add the vault's live Excluded-files rule to an existing readability predicate. */
export function withVaultExclusion(
  isReadable: (rel: string) => boolean,
  exclusion: VaultExclusion,
): (rel: string) => boolean {
  return (rel) => isReadable(rel) && !exclusion.isExcluded(rel);
}

/** Do two snapshots exclude by the same effective list? Used to decide whether a reload matters. */
export function sameExclusion(a: VaultExclusion, b: VaultExclusion): boolean {
  return (
    a.effective.length === b.effective.length && a.effective.every((e, i) => e === b.effective[i])
  );
}
