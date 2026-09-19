// THE-1079 (GH #947): a regression guard against the BUILT BUNDLE specifically. Every other test
// covering the local-reranker resolution ladder (reranker-local-resolution.test.ts,
// reranker-auto-select.test.ts) imports registry.ts's exports directly, running under `bun` from
// `src/` — exactly the one location the old fixed `../../../` walk happened to land correctly from.
// It never caught that `packages/server/dist/cli.js` (one directory level shallower) computed a
// path missing its `packages/` segment entirely, so the doctor remedy it printed ("bun run build in
// packages/reranker-local") was a no-op for every stdio install: the resolver never looked in the
// place that command builds.
//
// Runs a REAL built cli.js, but assembled into a throwaway monorepo-shaped tree
// (`<stage>/fake-root/packages/{server/dist,reranker-local}`) rather than in place: the resolution
// ladder's upward walk is exercised exactly as the real bug reproduced it (three levels under
// packages/), while never touching the SHARED `packages/reranker-local/dist` that
// reranker-local-resolution.test.ts and reranker-auto-select.test.ts build and delete in their own
// beforeAll/afterAll — vitest runs test files in parallel, and racing a second builder against that
// same directory is exactly the hazard those files' own comments already document.
//
// Cross-vendor review hardening: this file used to `bun run build` packages/server IN PLACE (real
// packages/server/dist) and unconditionally `rm -rf` it in cleanup — clobbering a developer's own
// build and racing anything else that touches that path. packages/server's own bundle step needs no
// package.json `main` resolution for ITS OWN output, so it can target a private `--outdir` directly
// (bypassing `bun run build` — replicated here without the copy-assets.mjs step, which only vendors
// migrations/plugin assets this test never needs: migrations are compiled into the bundle via
// db/migrations-embedded.ts, not read from `dist/migrations` at runtime). packages/shared has no
// such escape hatch — bun's bundler resolves `@the-40-thieves/obsidian-tc-shared` via ITS OWN
// package.json `main` (`./dist/index.js`), a path fixed relative to that package's real directory,
// so its dist MUST exist there for packages/server to bundle at all.
//
// Round 2 review fix: an earlier version RENAMED a pre-existing packages/shared/dist aside and
// restored it in afterAll with no try/finally — killed in between and the developer's real dist was
// stranded under the backup name, with a rerun then building a fresh one and afterAll deleting it,
// restoring nothing. Fixed by never renaming the real dist at all: reuse it as-is when present, or
// build it and LEAVE it (a built dist is the normal state of a checkout). `reclaimStrandedShared-
// DistBackups` self-heals a tree already damaged by that old version.
//
// Round 3 review fixes (three more bugs):
//   1. `spawnSync` below now passes an explicit, SANITIZED `env` — the bare `process.env` this test
//      used to inherit lets a host-set `OBSIDIAN_TC_GATEWAY_URL` make `autoSelectLocalRerankerConfig
//      Allows` return false (reranker-preflight.ts: any non-empty gateway URL means "gateway wins"),
//      silently skipping the very auto-select path this test exists to exercise.
//   2. no longer installs/builds the REAL reranker-local package at all (an isolated `bun install`
//      of @huggingface/transformers — ~230MB — just so `tsc` can resolve a specifier the package's
//      own src/index.ts never imports at top level, since doctor's probe only ever IMPORTS the
//      module, never calls `createReranker`/`rerank()`). A minimal STUB `dist/index.js` exporting
//      the same surface is written directly into the fake tree — the real package's actual shape is
//      already pinned by reranker-local-resolution.test.ts; this file's job is the PATH arithmetic
//      from a built bundle, not the package's contents. Also dropped `--minify` from the server
//      bundle build: irrelevant to path resolution, and it was pure added build cost here.
//   3. building packages/shared in place with no try/finally could leave a PARTIAL `dist/index.js`
//      behind if killed mid-`tsc`, which a later run would then treat as complete and authoritative.
//      Builds into a private temp dir first, then `renameSync`s the completed result into place in
//      one atomic step — `dist` is therefore always either absent or complete, never partial.
//
// Round 4 review fixes (two concurrency bugs the above still left open):
//   1. atomic publication had no CONCURRENT-WINNER handling: two vitest processes can both see
//      `dist/index.js` absent, both build to their own temp dir, and the second `renameSync` then
//      throws EEXIST/ENOTEMPTY even though a perfectly good `dist` now exists (the first process's).
//      Caught narrowly: only those two codes, and only after confirming the winner's
//      `dist/index.js` is actually there — any other error (or a still-missing dist) still
//      propagates. The loser's own temp output is then just discarded.
//   2. `reclaimStrandedSharedDistBackups` deleted EVERY leftover backup/temp-build dir unconditionally
//      — including one a CONCURRENTLY RUNNING vitest process is still building into. Each name
//      carries the owning pid (`<prefix><pid>`); a directory is reclaimed only when that pid is
//      confirmed DEAD (`process.kill(pid, 0)` throws ESRCH) or the directory is simply too old
//      (mtime > 1h — covers a reused pid or an unparseable name) to plausibly be a live build. The
//      actual reclaim action (rename back only when `dist` is absent, else discard) is unchanged.
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmTemp } from "./tmp";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(HERE, "..");
const REPO_ROOT = join(SERVER_DIR, "..", "..");
const SHARED_DIR = join(REPO_ROOT, "packages", "shared");
const SHARED_DIST = join(SHARED_DIR, "dist");
const SHARED_TSC = join(REPO_ROOT, "node_modules", ".bin", "tsc");
const REAL_RERANKER_LOCAL_NAME = "@the-40-thieves/obsidian-tc-reranker-local";
const SHARED_DIST_BACKUP_PREFIX = "dist.obtc-bundle-test-backup-";
const SHARED_DIST_TEMP_PREFIX = ".dist-tmp-obtc-bundle-test-";

const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

let stage: string;
let configPath: string;
let fakeCliJs: string;

/** A leftover backup/temp-build dir is safe to reclaim only once its owning process is confirmed
 *  gone, or the directory is simply too old to plausibly still be someone's live build (covers a
 *  reused pid, or a name this host could not parse a pid out of at all). Pure and injectable —
 *  no filesystem or process access — so every branch is directly unit-testable below with a fake
 *  `isAlive`/`nowMs`/`mtimeMs`, without needing a real second process or a real stale directory. */
const STALE_BUILD_DIR_AGE_MS = 60 * 60 * 1000; // 1 hour
function isStaleBuildDir(opts: { isAlive: boolean; mtimeMs: number; nowMs: number }): boolean {
  if (!opts.isAlive) return true;
  return opts.nowMs - opts.mtimeMs > STALE_BUILD_DIR_AGE_MS;
}

/** Extracts the trailing `<pid>` this test always names its own directories with
 *  (`<prefix><pid>`); undefined for anything that doesn't parse as one (a name this test did not
 *  create in the expected shape — treated as "liveness unknown", never as "confirmed dead", by
 *  the caller below). */
function pidFromName(name: string, prefix: string): number | undefined {
  // Strict decimal only (round 5 review): `Number()` would accept "1e3", "0x10" or "+42" and
  // turn an unexpected name into a "confirmed" pid; anything but plain digits is "unknown".
  const raw = name.slice(prefix.length);
  return /^[1-9]\d*$/.test(raw) ? Number(raw) : undefined;
}

/** `process.kill(pid, 0)` sends no signal — it only tests whether this process COULD signal `pid`.
 *  ESRCH means no such process exists (dead); any other error (most commonly EPERM: it exists but
 *  is owned by someone else) means it is very much alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Round 4 review fix 2: an unparseable name means liveness cannot be determined from the pid
 *  alone — treated as "alive" (the cautious default) so only the AGE half of `isStaleBuildDir`
 *  can still reclaim it, rather than a naming quirk silently deleting someone's live build. */
function isReclaimable(dirPath: string, name: string, prefix: string, nowMs: number): boolean {
  const pid = pidFromName(name, prefix);
  const isAlive = pid === undefined ? true : isProcessAlive(pid);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(dirPath).mtimeMs;
  } catch (e) {
    // Round 5 review: between readdir and stat, a CONCURRENT builder may have published or
    // discarded this very directory; a vanished entry is "nothing to reclaim", not a failure.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  return isStaleBuildDir({ isAlive, mtimeMs, nowMs });
}

/** Self-heals a tree damaged by an earlier version of this test that renamed the real dist aside
 *  and could be killed before restoring it (see the file header). Any leftover backup found on
 *  start either IS the developer's real dist (nothing has replaced it since) — rename it back — or
 *  a real dist already exists (a since-completed run rebuilt one) — the backup is then a stale
 *  orphan, safe to delete. A backup/temp-build dir whose owning process is still alive (round 4
 *  review fix 2) is left alone entirely — it belongs to a CONCURRENTLY RUNNING vitest process, not
 *  a killed one. Logs which action it took and on which name, since silently picking between
 *  "restore" and "discard" on someone else's build artifact is worth a paper trail. */
function reclaimStrandedSharedDistBackups(): void {
  const nowMs = Date.now();
  for (const name of readdirSync(SHARED_DIR)) {
    if (!name.startsWith(SHARED_DIST_BACKUP_PREFIX)) continue;
    const backup = join(SHARED_DIR, name);
    if (!isReclaimable(backup, name, SHARED_DIST_BACKUP_PREFIX, nowMs)) continue;
    if (existsSync(SHARED_DIST)) {
      console.log(
        `[doctor-cli-bundle-reranker-resolution] discarding stale backup ${name} (a real dist already exists)`,
      );
      rmSync(backup, { recursive: true, force: true });
    } else {
      console.log(
        `[doctor-cli-bundle-reranker-resolution] restoring stranded backup ${name} -> dist`,
      );
      renameSync(backup, SHARED_DIST);
    }
  }
  // Same reasoning, for a temp-build dir (round 3 fix 3) orphaned by an earlier kill mid-`tsc`:
  // never authoritative (never renamed INTO `dist`), so always safe to discard once confirmed dead.
  for (const name of readdirSync(SHARED_DIR)) {
    if (!name.startsWith(SHARED_DIST_TEMP_PREFIX)) continue;
    const tempDir = join(SHARED_DIR, name);
    if (isReclaimable(tempDir, name, SHARED_DIST_TEMP_PREFIX, nowMs)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

/** Builds packages/shared/dist ATOMICALLY: `tsc` writes into a private temp directory first, then
 *  a single `renameSync` publishes it as `dist` — so a kill mid-build leaves `dist` absent (the
 *  orphaned temp dir is swept by `reclaimStrandedSharedDistBackups` above, once confirmed dead),
 *  never a partial, silently-treated-as-complete `dist`.
 *
 *  Round 4 review fix 1: two processes can both see `dist/index.js` absent and both reach this
 *  rename — only ONE wins; the other's `renameSync` throws EEXIST (already a directory there) or
 *  ENOTEMPTY (Linux's spelling of the same race). That is not a real failure: the winner's `dist`
 *  is exactly as valid as this process's own would have been (same source, same compiler), so this
 *  verifies it actually landed, discards its own now-redundant temp output, and returns normally.
 *  Any OTHER error — or the rename failing with one of those codes yet `dist/index.js` still
 *  missing — still propagates; that is a real failure, not a lost race. */
function buildSharedDistAtomically(): void {
  const tempOut = join(SHARED_DIR, `${SHARED_DIST_TEMP_PREFIX}${process.pid}`);
  rmSync(tempOut, { recursive: true, force: true });
  execFileSync(SHARED_TSC, ["--outDir", tempOut], { cwd: SHARED_DIR, stdio: "pipe" });
  try {
    renameSync(tempOut, SHARED_DIST);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOTEMPTY") throw e;
    if (!existsSync(join(SHARED_DIST, "index.js"))) throw e;
    rmSync(tempOut, { recursive: true, force: true });
  }
}

/** A minimal stand-in for the REAL @the-40-thieves/obsidian-tc-reranker-local package (round 3 fix
 *  2): doctor's probe (`probeLocalRerankerResolution`) only ever IMPORTS this module to prove
 *  resolution succeeded — it never calls `createReranker`, so the stub need not do anything real.
 *  The actual package's shape/behavior is pinned by reranker-local-resolution.test.ts; this file's
 *  job is proving the PATH ARITHMETIC from a built bundle, which needs no real weights, no
 *  @huggingface/transformers, and no `tsc` of the real source at all. */
function writeStubRerankerLocal(dir: string): void {
  mkdirSync(dir, { recursive: true });
  // THE-1079 hardening: the anchor's `name` field is actually READ and checked, so this must be
  // the real package name. `type: module` matches the real package.json — required for a plain
  // `.js` file at this fixed path to be interpreted as ESM by the dynamic `import()`.
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: REAL_RERANKER_LOCAL_NAME, type: "module" })}\n`,
  );
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(
    join(dir, "dist", "index.js"),
    "export function createReranker() {\n" +
      '  throw new Error("stub reranker-local (THE-1079 test) — never actually invoked");\n' +
      "}\n",
  );
}

describe.skipIf(!bunAvailable)(
  "doctor CLI (BUILT bundle) — local-reranker auto-select (THE-1079, GH #947/#949)",
  { timeout: 180_000 },
  () => {
    beforeAll(() => {
      stage = mkdtempSync(join(tmpdir(), "obtc-bundle-reranker-"));
      reclaimStrandedSharedDistBackups();

      // 1) packages/shared: bun's bundler resolves it via ITS OWN package.json `main`
      // (./dist/index.js, fixed relative to packages/shared itself) — there is no `--outdir` that
      // redirects a DEPENDENCY's own resolution, so this is the one directory this test cannot
      // avoid touching. Reuse an existing dist as-is; build (atomically) only when absent.
      if (!existsSync(join(SHARED_DIST, "index.js"))) {
        buildSharedDistAtomically();
      }
      expect(existsSync(join(SHARED_DIST, "index.js"))).toBe(true);

      // 2) packages/server: build straight into a PRIVATE outdir under `stage`, bypassing
      // `bun run build` (which hardcodes `--outdir ./dist`) so the real packages/server/dist is
      // never touched at all. Only cli.ts — this test never needs the MCP server entry (index.ts)
      // or copy-assets.mjs's migrations/plugin vendoring (see file header). No `--minify`: this
      // test only exercises path resolution, never inspects bundle size or readability.
      const privateServerDist = join(stage, "server-dist");
      execFileSync(
        "bun",
        [
          "build",
          "./src/cli.ts",
          "--outdir",
          privateServerDist,
          "--target",
          "node",
          "--external",
          "better-sqlite3",
          "--external",
          REAL_RERANKER_LOCAL_NAME,
        ],
        { cwd: SERVER_DIR, stdio: "pipe" },
      );
      const realCliJs = join(privateServerDist, "cli.js");
      expect(existsSync(realCliJs)).toBe(true);

      // 3) Assemble the fake monorepo root: packages/server/dist/cli.js three levels under
      // packages/reranker-local/{package.json,dist/index.js} — the exact shape the real bug's
      // fixed-`../../../` walk got wrong from. Relocating the ALREADY-BUILT cli.js is what makes
      // this a genuine test of "wherever this module actually runs", not a repeat of the in-place
      // case route (iii) always happened to pass from source.
      const fakeRoot = join(stage, "fake-root");
      const fakeServerDist = join(fakeRoot, "packages", "server", "dist");
      mkdirSync(fakeServerDist, { recursive: true });
      copyFileSync(realCliJs, join(fakeServerDist, "cli.js"));
      writeStubRerankerLocal(join(fakeRoot, "packages", "reranker-local"));
      fakeCliJs = join(fakeServerDist, "cli.js");

      configPath = join(stage, "config.json");
      writeFileSync(
        configPath,
        `${JSON.stringify(
          {
            // No reranker block, no gateway URL, default `ollama` embeddings (no modelTier.full) —
            // exactly autoSelectLocalRerankerConfigAllows's "yes" case, on a supported platform
            // (this box is linux glibc): auto-select "local" is attempted at boot.
            vaults: [{ id: "smoke", path: join(stage, "vault") }],
            cacheDir: join(stage, "cache"),
          },
          null,
          2,
        )}\n`,
      );
    }, 180_000);

    afterAll(() => {
      // packages/shared/dist is left alone, whether it pre-existed or we just built it — a built
      // dist is the normal state of a checkout, not test debris (see file header for why this test
      // used to delete it, and why that was wrong). packages/server/dist was never touched at all
      // (built into a private outdir instead).
      try {
        rmTemp(stage);
      } catch {
        // best effort
      }
    });

    it("bun is on PATH, so this suite is actually running", () => {
      expect(bunAvailable).toBe(true);
    });

    it("reranker.buildable resolves the auto-selected local reranker via source-checkout, from the BUILT dist/cli.js", () => {
      // Round 3 review fix 1: an explicit, SANITIZED env — inheriting the bare host environment let
      // a set OBSIDIAN_TC_GATEWAY_URL make autoSelectLocalRerankerConfigAllows return false
      // (reranker-preflight.ts), silently skipping auto-select and failing the assertions below on
      // any host that happens to have the var set. HOME/TMPDIR are pinned to `stage` so capability
      // detection (resolveCapabilityProfile) probes a throwaway tree instead of this host's real
      // Obsidian config.
      const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: stage, TMPDIR: stage };
      delete childEnv.OBSIDIAN_TC_GATEWAY_URL;
      delete childEnv.OBSIDIAN_TC_GATEWAY_TOKEN;

      const r = spawnSync("bun", [fakeCliJs, "doctor", configPath, "--json"], {
        encoding: "utf8",
        timeout: 60_000,
        env: childEnv,
      });
      expect(r.status, `stderr: ${r.stderr}`).toBe(0);
      const report = JSON.parse(r.stdout) as {
        checks: Record<
          string,
          { status: string; summary: string; details?: Record<string, unknown> }
        >;
      };
      const check = report.checks["reranker.buildable"];
      expect(check, "doctor produced no reranker.buildable check").toBeTruthy();
      // The bug: from the built bundle, the ladder's source-checkout route probed a path missing
      // its `packages/` segment and could never find a build that genuinely exists on disk.
      expect(check?.status).toBe("ok");
      expect(check?.summary).toContain('auto-selected "local"');
      expect(check?.details?.route).toBe("source-checkout");

      // GH #949, asserted against the BUILT bundle too (not just the source-level unit test in
      // doctor-checks.test.ts): retrieval.heads must reflect the SAME resolved auto-select in this
      // SAME run, not still read RRF-only — a bundler/minify slip dropping the threaded
      // `autoSelectLocalRerankerResolved` field would silently pass the reranker.buildable
      // assertion above but fail here.
      const heads = report.checks["retrieval.heads"];
      expect(heads, "doctor produced no retrieval.heads check").toBeTruthy();
      expect(heads?.details?.reranker).toContain("auto-select resolved the local reranker module");
      expect(heads?.details?.reranker).not.toContain("RRF-only");
    });
  },
);

// THE-1079 round 4 review fix 2: `isStaleBuildDir` decides whether a leftover backup/temp-build
// dir is safe to reclaim WITHOUT ever touching the filesystem or a real process — every branch
// exercised here with a fake `isAlive`/clock, no real second process and no real stale directory
// needed.
describe("isStaleBuildDir (THE-1079 round 4 review fix 2)", () => {
  const HOUR = 60 * 60 * 1000;

  it("never reclaims a directory whose owning process is confirmed alive and recent", () => {
    expect(isStaleBuildDir({ isAlive: true, mtimeMs: 1000, nowMs: 1000 })).toBe(false);
  });

  it("reclaims immediately once the owning process is confirmed dead, regardless of age", () => {
    expect(isStaleBuildDir({ isAlive: false, mtimeMs: 1000, nowMs: 1000 })).toBe(true);
    expect(isStaleBuildDir({ isAlive: false, mtimeMs: 1000, nowMs: 1000 + 999 * HOUR })).toBe(true);
  });

  it("an 'alive' directory (unparseable name, or a live pid) is still reclaimed once old enough", () => {
    expect(isStaleBuildDir({ isAlive: true, mtimeMs: 0, nowMs: HOUR })).toBe(false); // exactly 1h: not yet
    expect(isStaleBuildDir({ isAlive: true, mtimeMs: 0, nowMs: HOUR + 1 })).toBe(true); // just over
  });
});
