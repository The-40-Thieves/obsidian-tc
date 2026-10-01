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
import { join, relative, sep } from "node:path";

/** Set by the globalSetup to the run's private root; read by the per-file setup. */
export const TMP_GUARD_ROOT_ENV = "OBTC_TEST_TMP_ROOT";

/** Prefix of the per-run private root. */
export const RUN_ROOT_PREFIX = "obtc-run-";

/** A run root older than this belongs to a run that was killed (SIGKILL, OOM, a closed terminal)
 *  before its teardown could delete it; no suite runs for six hours. */
export const STALE_RUN_ROOT_MS = 6 * 60 * 60 * 1000;

/** A leftover that is allowed to survive a test file. Each entry needs a reason: this is for a
 *  genuinely shared cache that outlives a test by design, never for a fixture that forgot its
 *  teardown. Empty on purpose; a leak is fixed in the test, not allowlisted. */
export interface AllowedLeftover {
  /** Matches the leftover's basename. */
  readonly entry: RegExp;
  readonly reason: string;
}
export const ALLOWED_LEFTOVERS: readonly AllowedLeftover[] = [];

export interface Leak {
  /** The per-test-file subdirectory the leftover sits in. */
  readonly file: string;
  /** The leftover's basename. */
  readonly entry: string;
  readonly bytes: number;
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

function dirBytes(path: string): number {
  let total = 0;
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
      continue;
    }
    try {
      for (const name of readdirSync(cur)) stack.push(join(cur, name));
    } catch {
      // unreadable directory: count what we can see
    }
  }
  return total;
}

/** Everything left under `runRoot/<file>/` that is not allowlisted. A test file whose own
 *  subdirectory is empty (or was never created) contributes nothing. */
export function scanLeaks(
  runRoot: string,
  allow: readonly AllowedLeftover[] = ALLOWED_LEFTOVERS,
): Leak[] {
  const leaks: Leak[] = [];
  for (const file of readdirSync(runRoot).sort()) {
    const fileDir = join(runRoot, file);
    let entries: string[];
    try {
      entries = readdirSync(fileDir);
    } catch {
      // A plain file placed directly in the root (not a per-file dir) is a leak of its own.
      leaks.push({ file: ".", entry: file, bytes: dirBytes(fileDir) });
      continue;
    }
    for (const entry of entries.sort()) {
      if (allow.some((a) => a.entry.test(entry))) continue;
      leaks.push({ file, entry, bytes: dirBytes(join(fileDir, entry)) });
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
  const groups = new Map<string, { count: number; bytes: number }>();
  const prefixes = new Map<string, number>();
  for (const l of leaks) {
    const prefix = prefixOf(l.entry);
    const key = `${l.file}/${prefix}-*`;
    const g = groups.get(key) ?? { count: 0, bytes: 0 };
    g.count += 1;
    g.bytes += l.bytes;
    groups.set(key, g);
    prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
  }
  const lines = [
    `${leaks.length} temp entr${leaks.length === 1 ? "y" : "ies"} (${size(total)}) in ${groups.size} place(s) outlived the test file that created them:`,
  ];
  const rows = [...groups].sort((a, b) => b[1].bytes - a[1].bytes || b[1].count - a[1].count);
  for (const [key, g] of rows.slice(0, limit))
    lines.push(`  ${key}  x${g.count}  (${size(g.bytes)})`);
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
