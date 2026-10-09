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
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRegexExclusionEntry } from "@the-40-thieves/obsidian-tc-shared";
import { readNoteBounded } from "../vault/notes-io";
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
  /** Stable identity of `effective`, used by ACL-set and result-cache keys. */
  digest: string;
}

/** Stable digest of the effective exclusion list. Order is retained so the persisted snapshot and
 * runtime identity describe the exact same config value, even though matching itself is an OR. */
export function exclusionDigest(entries: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/** Nothing excluded. */
export const NO_EXCLUSION: VaultExclusion = {
  isExcluded: () => false,
  effective: [],
  obsidian: [],
  config: [],
  invalid: [],
  digest: exclusionDigest([]),
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

interface PersistedLastGood {
  version: 1;
  root: string;
  entries: string[];
}

/** Durable last-good location beside the index, keyed by canonical vault root rather than a
 * caller-controlled vault id. */
export function exclusionStatePath(cacheDir: string, root: string): string {
  const key = createHash("sha256").update(root).digest("hex");
  return join(cacheDir, "index-exclusions", `${key}.json`);
}

function readPersistedLastGood(path: string | undefined, root: string): string[] | undefined {
  if (!path) return undefined;
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_APP_CONFIG_BYTES) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedLastGood>;
    if (parsed.version !== 1 || parsed.root !== root || !Array.isArray(parsed.entries))
      return undefined;
    return clean(parsed.entries);
  } catch {
    return undefined;
  }
}

function persistLastGood(path: string | undefined, root: string, entries: readonly string[]): void {
  if (!path) return;
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const value: PersistedLastGood = { version: 1, root, entries: [...entries] };
    writeFileSync(temp, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } catch (e) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp may never have been created.
    }
    process.stderr.write(
      `[index] warning: could not persist last-good exclusion list: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}

function failedRead(
  root: string,
  sig: string,
  error: string,
  cached: (typeof appConfigCache extends Map<string, infer V> ? V : never) | undefined,
  statePath?: string,
  persisted?: readonly string[],
): AppConfigRead {
  if (cached?.sig === sig) return cached.read;
  const lastGood = cached?.lastGood ?? persisted ?? readPersistedLastGood(statePath, root);
  const read = { entries: [...(lastGood ?? [])], error };
  appConfigCache.set(root, { sig, read, lastGood });
  process.stderr.write(
    lastGood
      ? `[index] warning: ${error}; keeping the last-good exclusion list\n`
      : `[index] warning: ${error}; no last-good exclusion list is available\n`,
  );
  return read;
}

function readAppConfig(root: string, statePath?: string): AppConfigRead {
  const file = join(root, OBSIDIAN_APP_CONFIG);
  let sig: string;
  try {
    const st = lstatSync(file);
    // A symlink, a non-file or a hard link is not read (same stance as the vault's own file reads:
    // a second directory entry for an inode could alias an ACL-denied file into this path).
    if (!st.isFile() || st.nlink > 1 || st.size > MAX_APP_CONFIG_BYTES) {
      return failedRead(
        root,
        `invalid:${st.mode}:${st.size}:${st.mtimeMs}:${st.nlink}`,
        "app.json is not a single-link regular file of readable size",
        appConfigCache.get(root),
        statePath,
      );
    }
    sig = `${st.size}:${st.mtimeMs}`;
  } catch (e) {
    const cached = appConfigCache.get(root);
    const code = (e as NodeJS.ErrnoException).code;
    const persisted = cached === undefined ? readPersistedLastGood(statePath, root) : undefined;
    if (code === "ENOENT" && cached === undefined && persisted === undefined)
      return { entries: [] };
    return failedRead(
      root,
      code === "ENOENT" ? "missing" : `unreadable:${code ?? "unknown"}`,
      code === "ENOENT"
        ? "app.json became unavailable"
        : `app.json could not be inspected: ${e instanceof Error ? e.message : String(e)}`,
      cached,
      statePath,
      persisted,
    );
  }
  const cached = appConfigCache.get(root);
  if (cached?.sig === sig) return cached.read;
  try {
    // Through the opened-fd guard (nlink and file type checked on the same descriptor that is read),
    // not a path read after the lstat above: the file may have been swapped since.
    const { raw: text } = readNoteBounded(file, MAX_APP_CONFIG_BYTES);
    if (text === null) throw new Error("app.json is larger than the readable size");
    const parsed: unknown = JSON.parse(text);
    const raw =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { userIgnoreFilters?: unknown }).userIgnoreFilters
        : undefined;
    const read = { entries: Array.isArray(raw) ? clean(raw) : [] };
    appConfigCache.set(root, { sig, read, lastGood: read.entries });
    persistLastGood(statePath, root, read.entries);
    return read;
  } catch (e) {
    const error = `app.json could not be read: ${e instanceof Error ? e.message : String(e)}`;
    return failedRead(root, sig, error, cached, statePath);
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
  statePath?: string,
): VaultExclusion {
  const app = readAppConfig(root, statePath);
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
    digest: exclusionDigest(effective),
    ...(app.error !== undefined ? { appConfigError: app.error } : {}),
  };
}

/** The vault-resolving slice of `VaultRegistry` this module needs (keeps the dependency one-way). */
export interface ExclusionVaultLookup {
  resolve(vault?: string | null): {
    root: string;
    indexExcludePaths?: readonly string[];
    exclusionCacheDir?: string;
  };
}

/** Per-vault exclusion snapshot for `vaultId`, resolved through the registry. */
export function vaultExclusionFor(lookup: ExclusionVaultLookup, vaultId: string): VaultExclusion {
  const v = lookup.resolve(vaultId);
  return loadVaultExclusion(
    v.root,
    v.indexExcludePaths ?? [],
    v.exclusionCacheDir ? exclusionStatePath(v.exclusionCacheDir, v.root) : undefined,
  );
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
