// install.conflict-copies (THE-939, GH #881) — warns when a sync service (iCloud, Dropbox,
// Syncthing) has written a conflict-copy sibling into the install directory.
//
// GitHub issue #881: an iCloud-synced clone accumulated `cli 2.ts` / `config.schema 2.ts`
// alongside the real files. Both are untracked — no repo risk — but indistinguishable from source
// to any tool that walks the tree; the reporter's grep resolved to a stale sibling and they read a
// schema field that had since moved before noticing the space in the path. Dropbox
// ("file (conflicted copy).ts") and Syncthing ("file.sync-conflict-*.ts") write the same shape of
// hazard under different naming conventions.
//
// Its own module, same reasoning as capture-location.ts and note-summary-scale.ts: checks.ts is
// already comment-dense against biome's 700-line ceiling, and this is a self-contained classifier
// with its own resolution step (finding the install root) that the other checks don't need.
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Check, CheckStatus } from "./types";

// Basename tests only — a directory named e.g. "2026 2" must never be inspected as if it were a
// file. Case-sensitive, matching the rulings: sync clients write these suffixes verbatim.
const ICLOUD_CONFLICT = / \d+\.(ts|js|mjs|cjs|json|md)$/;
const DROPBOX_CONFLICT = / \(conflicted copy/i;
const SYNCTHING_CONFLICT = /\.sync-conflict-/;

function matchesConflictPattern(basename: string): boolean {
  return (
    ICLOUD_CONFLICT.test(basename) ||
    DROPBOX_CONFLICT.test(basename) ||
    SYNCTHING_CONFLICT.test(basename)
  );
}

// Directories that are never real source and are frequently huge (node_modules) or hold the same
// filename under a different meaning (.git's object store). Skipping them is also what keeps the
// bounded walk below cheap enough to run on every default doctor pass, unguarded by `--probe`.
//
// `dist` is deliberately NOT in this always-skip set. Fix round 1 (PR #900 review, HIGH finding):
// packages/server/package.json's `files` field ships ONLY `dist` (plus README/SKILLS/LICENSE) to
// npm — an installed copy of this package has no `src` at all, and every line the running server
// executes lives under `dist`. Unconditionally skipping `dist` made the check walk an npm install's
// root and find nothing to inspect, ever: a permanent false "ok" for exactly the deployment mode a
// real end user runs (the reviewer reproduced this with a real `dist/cli 2.js` fixture). `dist` is
// skipped only in a SOURCE CHECKOUT, where it holds build output alongside real `src` — see
// `isSourceCheckout` below for what distinguishes the two layouts.
const ALWAYS_SKIP_DIRS = new Set(["node_modules", ".git", "target", ".cache"]);

/**
 * True when `root` is a source checkout rather than an installed (npm/dist-only) copy of this
 * package. `resolveInstallRoot()` below returns the directory holding this package's
 * `package.json`; in a source checkout that directory also holds `src/` (the checked-in
 * TypeScript), while an npm install's `files` field never ships `src` at all — only `dist`. That
 * single directory's presence is therefore exactly the signal `scanForConflictCopies` needs to
 * decide whether `dist` is build output worth skipping or the entirety of what shipped.
 */
function isSourceCheckout(root: string): boolean {
  return existsSync(join(root, "src"));
}

/** Directories deeper than this under the install root are not descended into. */
export const CONFLICT_COPY_MAX_DEPTH = 8;
/** The walk stops counting files past this many and reports the scan as truncated. */
export const CONFLICT_COPY_MAX_FILES = 20_000;

/**
 * Walk `root` for conflict-copy siblings, never following symlinks and never descending into a
 * skipped directory or past `maxDepth`. `dist` is skipped only when `root` is a source checkout
 * (see `isSourceCheckout`) — an npm install has no `src`, and `dist` there IS the install, not
 * build output to ignore. Stops as soon as it has seen `maxFiles` files and reports
 * `truncated: true` rather than silently returning a partial, unlabeled result — an unreadable
 * subdirectory (permissions) is skipped the same way, since a doctor check must not throw over one
 * bad directory.
 */
function scanForConflictCopies(
  root: string,
  maxDepth: number,
  maxFiles: number,
): { matches: string[]; truncated: boolean } {
  const matches: string[] = [];
  let filesSeen = 0;
  let truncated = false;
  const skipDirs = isSourceCheckout(root)
    ? new Set([...ALWAYS_SKIP_DIRS, "dist"])
    : ALWAYS_SKIP_DIRS;

  const walk = (dir: string, depth: number): void => {
    if (truncated || depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip it rather than fail the whole scan
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.isSymbolicLink()) continue; // symlinks are never followed
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(join(dir, entry.name), depth + 1);
        if (truncated) return;
      } else if (entry.isFile()) {
        filesSeen++;
        if (filesSeen > maxFiles) {
          truncated = true;
          return;
        }
        if (matchesConflictPattern(entry.name)) {
          // Vault-relative (here: install-root-relative), forward-slash — Windows' `\` separator
          // would otherwise leak into the report and disagree with every other check's paths.
          matches.push(relative(root, join(dir, entry.name)).split(sep).join("/"));
        }
      }
    }
  };

  walk(root, 0);
  return { matches, truncated };
}

const SERVER_PACKAGE_NAME = "obsidian-tc";
/** Bounds the upward package.json search — generous for any realistic checkout or install depth,
 *  tight enough that a frozen build-machine path from `bun --compile` (see below) cannot walk all
 *  the way to the filesystem root on an unrelated machine. */
const PACKAGE_ROOT_SEARCH_BOUND = 6;

/**
 * Resolve the install directory — "the package root the running server was loaded from" — by
 * walking up from this module's own `import.meta.url` until a `package.json` named "obsidian-tc"
 * is found.
 *
 * This works unchanged for both a source checkout (src/doctor -> src -> server, 2 hops) and a
 * built dist bundle (dist -> server, 1 hop) without hardcoding either offset: `bun build`
 * collapses every bundled module's `import.meta.url` onto the single output file's own path, so
 * the walk's starting depth differs but the destination — the directory holding this package's
 * `package.json` — does not.
 *
 * `bun --compile` freezes `import.meta.url` to the BUILD MACHINE's path (the same freeze
 * db/provision.ts and cli/shared.ts already document for the embedded-migrations path). On a
 * standalone binary run on a DIFFERENT machine that path does not exist there, `existsSync` never
 * matches, and this returns undefined — reported by the check as not-applicable, never as a false
 * "no conflict copies found".
 */
export function resolveInstallRoot(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < PACKAGE_ROOT_SEARCH_BOUND; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
        if (pkg.name === SERVER_PACKAGE_NAME) return dir;
      } catch {
        // malformed/unreadable package.json — keep walking up rather than treat this as a match
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined; // hit the filesystem root without finding it
    dir = parent;
  }
  return undefined;
}

export interface ConflictCopiesView {
  /** The install root to walk, from `resolveInstallRoot()`. Undefined means no source tree exists
   *  on this machine to inspect (a `bun --compile` binary run somewhere other than where it was
   *  built) — see that function's own comment. */
  installRoot: string | undefined;
  /** Overrides for tests only; a real caller always uses the exported defaults. */
  maxDepth?: number;
  maxFiles?: number;
}

/**
 * install.conflict-copies — does the install directory contain a sync-service conflict-copy
 * sibling (iCloud `file 2.ts`, Dropbox `file (conflicted copy).ts`, Syncthing
 * `file.sync-conflict-*.ts`)?
 *
 * These are untracked, so they carry no repo risk — but they parse and grep exactly like real
 * source, so a stale sibling answers a question with a plausible but outdated result and nothing
 * else in the system can tell the two apart. See this module's header for GH #881, the report that
 * asked for this check.
 *
 * A warning, never a fail: a conflict copy breaks no request in flight — what it breaks is trust in
 * the next grep. Never gated behind `--probe`: the walk is bounded (depth, file count) and
 * read-only, cheap enough to run on every default pass, same posture as
 * experiential.capture-location.
 */
export function conflictCopiesCheck(view: ConflictCopiesView): Check {
  return {
    id: "install.conflict-copies",
    category: "runtime",
    run: () => {
      if (view.installRoot === undefined) {
        return {
          status: "ok" as CheckStatus,
          summary: "conflict-copy scan: not applicable — no source tree found on this machine",
          details: {
            applicable: "false",
            conflictCopies:
              "not applicable (compiled binary; import.meta.url's build-time path does not exist here)",
          },
        };
      }

      const maxDepth = view.maxDepth ?? CONFLICT_COPY_MAX_DEPTH;
      const maxFiles = view.maxFiles ?? CONFLICT_COPY_MAX_FILES;
      const { matches, truncated } = scanForConflictCopies(view.installRoot, maxDepth, maxFiles);

      // details is map<string, string | string[]> (CheckResult's contract — see types.ts), so
      // `applicable` is the string "true", not a boolean, matching `truncated`'s own string shape
      // below.
      const details: Record<string, string | string[]> = {
        applicable: "true",
        installRoot: view.installRoot,
      };
      if (truncated) {
        details.truncated = `scan stopped after ${maxFiles} file(s) — the rest of the tree was not checked`;
      }

      if (matches.length === 0) {
        return {
          status: "ok" as CheckStatus,
          summary: "no sync-service conflict copies found in the install directory",
          details,
        };
      }

      details.matches = matches;
      return {
        status: "warning" as CheckStatus,
        summary: `${matches.length} sync-service conflict cop${matches.length === 1 ? "y" : "ies"} in the install directory`,
        details,
        issues: matches.map(
          (m) =>
            `${m} looks like a sync-service conflict copy — it may shadow the real file to any tool that walks the tree`,
        ),
        remediation:
          "Delete these conflict copies, or move the install off a sync-managed path (iCloud Drive, Dropbox, Syncthing).",
      };
    },
  };
}
