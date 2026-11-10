// Where a repository script may take an executable from.
//
// Starting `git` (or bun, docker, tar, ...) by bare name lets the OS search PATH, and PATH in a
// development checkout is not all trustworthy: `bun run` and npm put node_modules/.bin in front, so
// a dependency that ships a bin called `git` would be run by every gate; a relative or empty entry
// means "whatever is in the current directory". resolveExecutable walks PATH itself, skips those
// kinds of entry, and returns an ABSOLUTE path for execFile/spawn, so the OS never searches.
//
// It is not a sandbox: an absolute PATH directory outside the repository is trusted, as the shell
// that started the script already trusts it. Directory permissions are deliberately not judged:
// GitHub's hosted runners keep node in a mode-777 tool cache, so refusing world-writable
// directories would either fail there or silently pick a different node further down PATH.
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** What CreateProcess can start directly. A .cmd/.bat shim needs a shell, which these callers
 *  do not use, so it is not a match. */
const WINDOWS_EXTENSIONS = ["", ".exe", ".com"];

const realStat = (p) => {
  try {
    return statSync(p);
  } catch {
    return null;
  }
};

/** PATH is `Path` on Windows; take whichever spelling the environment uses. */
function pathValue(env) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  return key === undefined ? "" : (env[key] ?? "");
}

const NAME_CHARS = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+-");

/** A command name with no path separator, space or shell character in it. */
function isBareName(name) {
  if (typeof name !== "string" || name === "") return false;
  for (const ch of name) if (!NAME_CHARS.has(ch)) return false;
  return true;
}

function hasWindowsExtension(name) {
  const lower = name.toLowerCase();
  return lower.endsWith(".exe") || lower.endsWith(".com");
}

/** Whether `dir` is `root` or below it. Both are already resolved and case-folded. */
function isInside(p, root, dir) {
  const rel = p.relative(root, dir);
  return rel === "" || !(rel === ".." || rel.startsWith(`..${p.sep}`) || p.isAbsolute(rel));
}

/**
 * The absolute path of `name` in the first trustworthy PATH directory, or null when there is none.
 * `options` are seams for tests: `env`, `platform`, `repoRoot`, and `stat` (path -> Stats | null).
 */
export function resolveExecutable(name, options = {}) {
  if (!isBareName(name))
    throw new TypeError(`expected a bare command name, got ${JSON.stringify(name)}`);
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const stat = options.stat ?? realStat;
  const win = platform === "win32";
  const p = win ? path.win32 : path.posix;
  const repoRoot = p.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const fold = (s) => (win ? s.toLowerCase() : s);

  for (const entry of pathValue(env).split(win ? ";" : ":")) {
    if (entry === "" || !p.isAbsolute(entry)) continue;
    const dir = p.resolve(entry);
    if (isInside(p, fold(repoRoot), fold(dir))) continue;
    const dirStat = stat(dir);
    if (dirStat === null || !dirStat.isDirectory()) continue;
    for (const ext of win ? WINDOWS_EXTENSIONS : [""]) {
      const candidate = p.join(dir, name + ext);
      const s = stat(candidate);
      if (s === null || !s.isFile()) continue;
      if (!win && (s.mode & 0o111) === 0) continue;
      if (win && ext === "" && !hasWindowsExtension(name)) continue;
      return candidate;
    }
  }
  return null;
}

const cache = new Map();

/**
 * resolveExecutable, but a missing command throws an error with `code: "ENOENT"`, the same code
 * execFile reports for a command it cannot find, so a caller's existing handling still applies.
 * Results for the real environment are remembered for the life of the process.
 */
export function trustedExecutable(name, options) {
  const cached = options === undefined ? cache.get(name) : undefined;
  if (cached !== undefined) return cached;
  const found = resolveExecutable(name, options);
  if (found === null) {
    const error = new Error(
      `${name}: not found in a trusted PATH directory (directories inside the repository and relative entries are skipped)`,
    );
    error.code = "ENOENT";
    throw error;
  }
  if (options === undefined) cache.set(name, found);
  return found;
}

/**
 * The node binary to start a child node process with. Under node that is the binary already
 * running (no lookup at all); under bun, whose execPath is bun, it is node from PATH.
 */
export function nodeExecutable() {
  return process.versions.bun === undefined ? process.execPath : trustedExecutable("node");
}
