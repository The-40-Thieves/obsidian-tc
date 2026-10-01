// Run-scoped temp-dir containment + leak gate for the vitest suite (see tmp-guard-global-setup.ts).
//
// The class this closes: the suite's fixtures call `mkdtempSync(join(tmpdir(), ...))` directly, and
// one that skips or fails its teardown leaves the directory in the shared system tmp forever. On
// 2026-09-30 that was ~38k leaked directories (obtc-*, tc-*, check-*, where-*, ... plus 400-600 MB
// `obtc-reranker-auto-select-*` stage copies) and a 97%-full root disk. Nothing noticed, because a
// leak is silent on every run: POSIX reaps /tmp eventually and a CI runner is thrown away.
//
// Why a private root instead of "snapshot /tmp before, diff after": the shared tmp is written by
// every other process on the box (other agents' suites, editors, linters), so a before/after diff
// blames this run for their entries. A directory only this run's workers can write into has no such
// false positives, works the same on Windows/macOS (it is derived from `os.tmpdir()`, whatever that
// is), and names the leaking TEST FILE because each file gets its own subdirectory.

import { readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

/** Set by the globalSetup to the run's private root; read by the per-file setup. */
export const TMP_GUARD_ROOT_ENV = "OBTC_TEST_TMP_ROOT";

/** Prefix of the per-run private root. */
export const RUN_ROOT_PREFIX = "obtc-run-";

/** A run root older than this belongs to a run that was killed (SIGKILL, OOM, a closed terminal)
 *  before its teardown could delete it; no suite runs for six hours. */
export const STALE_RUN_ROOT_MS = 6 * 60 * 60 * 1000;

/** A leftover that is allowed to survive a test file. Each entry needs a reason: this is for what
 *  the setup files themselves own and cannot reliably remove, never for a fixture that forgot its
 *  teardown; a leak in a test is fixed in the test. Nothing allowlisted is left on disk: the run
 *  root is deleted after the scan either way. */
export interface AllowedLeftover {
  /** Matches the leftover's basename. */
  readonly entry: RegExp;
  /** Only exempt on this platform (the cause is that platform's own tool). */
  readonly platform?: NodeJS.Platform;
  /** A second condition on what is INSIDE the leftover, for a basename too generic to name its
   *  owner on its own. Receives the leftover's absolute path. */
  readonly contents?: (path: string) => boolean;
  readonly reason: string;
}

/** The scratch directory Windows PowerShell's `Add-Type` makes: a random 8-character name
 *  (`Path.GetRandomFileName()` without the dot) holding only files named after itself
 *  (`<name>.0.cs`, `.cmdline`, `.dll`, `.err`, ...), or nothing once csc has cleaned up. */
function isAddTypeScratch(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false;
    const name = basename(path);
    return readdirSync(path).every((child) => child.startsWith(`${name}.`));
  } catch {
    return false;
  }
}
export const ALLOWED_LEFTOVERS: readonly AllowedLeftover[] = [
  {
    entry: /^__PSScriptPolicyTest_/,
    reason:
      "Windows PowerShell writes one of these into %TEMP% every time a child powershell.exe starts " +
      "(its execution-policy probe) and never removes it. The product's setup flow shells out to " +
      "PowerShell; it is not a fixture's leak and cannot be tidied from a test.",
  },
  {
    entry: /^[a-z0-9]{8}$/,
    platform: "win32",
    contents: isAddTypeScratch,
    reason:
      "systeminformation (hardware.ts's enricher, reached by every capability profile: setup, " +
      "doctor, compact) runs `si.graphics()` through Windows PowerShell with `Add-Type " +
      "-TypeDefinition`, which compiles C# with csc.exe in a random 8-character directory under " +
      "%TEMP%. hardware.ts bounds the probe at 2 s and abandons it, so the powershell is killed " +
      "mid-compile or exits without removing the directory. Third-party tool debris, not a " +
      "fixture; no test creates an 8-character name, and the contents check (empty, or only " +
      "files named after the directory) keeps anything else a test writes reportable.",
  },
  {
    entry: /^otc-test-home-/,
    reason:
      "the HOME pin that home-isolation-setup.ts creates for EVERY file. A file whose tests are " +
      "all skipped (ratelimit-redis without REDIS_URL, live-companion) never runs afterAll, and the " +
      "worker's exit sweep races the globalSetup teardown's scan, so the pin can still be there. " +
      "No test creates this prefix; the whole run root is removed right after the scan.",
  },
];

export interface Leak {
  /** The per-test-file subdirectory the leftover sits in. */
  readonly file: string;
  /** The leftover's basename. */
  readonly entry: string;
  readonly bytes: number;
  /** Non-directory nodes inside it (a plain-file leftover counts itself): 0 means an empty
   *  directory chain with nothing in it. */
  readonly files: number;
  /** Up to a few names inside the leftover (empty for a plain file): enough to tell whose it is. */
  readonly children: readonly string[];
}

/** A filesystem-safe, bounded name for a test file, relative to the package root. */
export function fileSlug(testPath: string | undefined, packageRoot: string): string {
  if (!testPath) return "unknown-file";
  const rel = relative(packageRoot, testPath).split(sep).join("/");
  const slug = rel
    .replace(/\.test\.[cm]?[jt]sx?$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .slice(-48);
  return slug.length > 0 ? slug : "unknown-file";
}

/** Up to a few paths inside a leftover, relative to it, descending to the first leaf of each
 *  branch: `[cache, config.json]` for a flat fixture, `AppData/Local/Microsoft/...` for a tool's
 *  nested debris. Enough to tell whose it is when the only record is a CI log. */
function samplePaths(root: string, limit = 4, maxDepth = 8): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    if (names.length === 0 && rel !== "") out.push(rel);
    for (const name of names) {
      if (out.length >= limit) return;
      const child = rel === "" ? name : `${rel}/${name}`;
      const isDir = (() => {
        try {
          return statSync(join(dir, name)).isDirectory();
        } catch {
          return false;
        }
      })();
      if (isDir && depth < maxDepth) walk(join(dir, name), child, depth + 1);
      else out.push(child);
    }
  };
  walk(root, "", 0);
  return out;
}

function dirStats(path: string): { bytes: number; files: number } {
  let total = 0;
  let files = 0;
  const stack = [path];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(cur);
    } catch {
      continue;
    }
    if (!st.isDirectory()) {
      total += st.size;
      files += 1;
      continue;
    }
    try {
      for (const name of readdirSync(cur)) stack.push(join(cur, name));
    } catch {
      // unreadable directory: count what we can see
    }
  }
  return { bytes: total, files };
}

/** True for a leftover that is only empty directories. On Windows removing a directory while any
 *  handle on it is open succeeds as "delete pending": the entry keeps being listed until the last
 *  handle closes, and a worker's handle lives as long as the worker. A fixture that really forgot
 *  its teardown leaves files, so this is the one shape that cannot be told from a pending delete;
 *  the global teardown warns about it on win32 instead of failing. */
export function isEmptyDirChain(leak: Leak): boolean {
  return leak.files === 0 && leak.bytes === 0 && leak.children.length > 0;
}

/** Everything left under `runRoot/<file>/` that is not allowlisted. A test file whose own
 *  subdirectory is empty (or was never created) contributes nothing. */
export function scanLeaks(
  runRoot: string,
  allow: readonly AllowedLeftover[] = ALLOWED_LEFTOVERS,
  platform: NodeJS.Platform = process.platform,
): Leak[] {
  const leaks: Leak[] = [];
  for (const file of readdirSync(runRoot).sort()) {
    const fileDir = join(runRoot, file);
    let entries: string[];
    try {
      entries = readdirSync(fileDir);
    } catch {
      // A plain file placed directly in the root (not a per-file dir) is a leak of its own.
      leaks.push({ file: ".", entry: file, ...dirStats(fileDir), children: [] });
      continue;
    }
    for (const entry of entries.sort()) {
      const path = join(fileDir, entry);
      const allowed = (a: AllowedLeftover): boolean =>
        a.entry.test(entry) &&
        (a.platform === undefined || a.platform === platform) &&
        (a.contents === undefined || a.contents(path));
      if (allow.some(allowed)) continue;
      leaks.push({
        file,
        entry,
        ...dirStats(path),
        children: samplePaths(path),
      });
    }
  }
  return leaks;
}

function size(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(0)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

function prefixOf(entry: string): string {
  return entry.replace(/[-_.]?[A-Za-z0-9]{6}$/, "") || entry;
}

/** Human-readable report: one line per (test file, directory prefix) with a count and size, so a
 *  file that leaks one directory per test reads as one line, and every leaking file is named. */
export function formatLeakReport(leaks: readonly Leak[], limit = 80): string {
  const total = leaks.reduce((n, l) => n + l.bytes, 0);
  const groups = new Map<string, { count: number; bytes: number; sample: Leak }>();
  const prefixes = new Map<string, number>();
  for (const l of leaks) {
    const prefix = prefixOf(l.entry);
    const key = `${l.file}/${prefix}-*`;
    const g = groups.get(key) ?? { count: 0, bytes: 0, sample: l };
    g.count += 1;
    g.bytes += l.bytes;
    groups.set(key, g);
    prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
  }
  const lines = [
    `${leaks.length} temp entr${leaks.length === 1 ? "y" : "ies"} (${size(total)}) in ${groups.size} place(s) outlived the test file that created them:`,
  ];
  const rows = [...groups].sort((a, b) => b[1].bytes - a[1].bytes || b[1].count - a[1].count);
  for (const [key, g] of rows.slice(0, limit)) {
    const inside = g.sample.children.length > 0 ? ` [${g.sample.children.join(", ")}]` : "";
    lines.push(`  ${key}  x${g.count}  (${size(g.bytes)})  e.g. ${g.sample.entry}${inside}`);
  }
  if (rows.length > limit) lines.push(`  ... and ${rows.length - limit} more`);
  lines.push(
    `by prefix: ${[...prefixes]
      .sort((a, b) => b[1] - a[1])
      .map(([p, n]) => `${p} x${n}`)
      .join(", ")}`,
  );
  lines.push(
    "Create fixture dirs with makeTempDir() from test/tmp.ts (removed when the test or file ends,",
    "even if an assertion throws), or rmTemp() in a finally/afterEach. The run root has already",
    "been deleted, so this report is the only record of what leaked.",
  );
  return lines.join("\n");
}

/** Delete run roots a killed run left behind. A killed suite never reaches the teardown, so its
 *  whole private root (including any large stage copy a test had built) would otherwise sit in the
 *  system temp dir forever. Only `obtc-run-*` directories untouched for `maxAgeMs` are removed, so
 *  a concurrent run's live root and every other process's entries are left alone. */
export function sweepStaleRunRoots(
  base: string,
  now = Date.now(),
  maxAgeMs = STALE_RUN_ROOT_MS,
): string[] {
  const removed: string[] = [];
  for (const name of readdirSync(base)) {
    if (!name.startsWith(RUN_ROOT_PREFIX)) continue;
    const dir = join(base, name);
    try {
      const st = statSync(dir);
      if (!st.isDirectory() || now - st.mtimeMs < maxAgeMs) continue;
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      removed.push(name);
    } catch {
      // raced with its owner, or unreadable: not ours to fight over
    }
  }
  return removed;
}
