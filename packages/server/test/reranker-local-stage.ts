// GH #958 / THE-1085: reranker-local-resolution.test.ts and reranker-auto-select.test.ts both need
// a REAL, `tsc`-built copy of packages/reranker-local to exercise the resolution ladder's
// non-stubbed mechanics (a stub resolver is what let the original THE-705/THE-944 bugs ship
// unnoticed — see those files' own headers). They used to build that copy IN PLACE, in the real
// `packages/reranker-local/dist` — a developer's own build, unconditionally `rm -rf`'d in
// beforeAll/afterAll, and racy besides: vitest runs test files in parallel, and both files touched
// the same directory.
//
// This helper offers two ways to get a real, built module without that hazard:
//
//   - `stageRerankerLocalSource` + `buildStagedRerankerLocal` copy the package's SOURCE (no
//     node_modules, no dist — the "unbuilt checkout" shape) into a caller-supplied temp root and
//     build it there. Each caller passes its own `mkdtempSync`-generated root, so two files staging
//     in parallel can never collide. Used for every "built" assertion EXCEPT the one below.
//   - `ensureRealRerankerLocalDist` is for the one case that is inherently tied to the REAL,
//     fixed checkout path (registry.ts's automatic "route iii, no config" resolution — see its own
//     comment further down): reuse the real dist read-only when present, else build it IN PLACE,
//     behind a cross-process lock, and leave it — never delete it.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** Copies just what `tsc` needs to build packages/reranker-local — package.json, bun.lock (for
 *  `--frozen-lockfile`), tsconfig.json, and src/ — into `<stageRoot>/packages/reranker-local`,
 *  alongside the repo-root tsconfig.base.json its tsconfig extends via `../../tsconfig.base.json`
 *  (preserving that same relative nesting depth under `stageRoot`). Returns the staged package's
 *  directory. */
export function stageRerankerLocalSource(realRerankerLocalDir: string, stageRoot: string): string {
  const stagedPkg = join(stageRoot, "packages", "reranker-local");
  mkdirSync(stagedPkg, { recursive: true });
  for (const name of ["package.json", "bun.lock", "tsconfig.json"]) {
    cpSync(join(realRerankerLocalDir, name), join(stagedPkg, name));
  }
  cpSync(join(realRerankerLocalDir, "src"), join(stagedPkg, "src"), { recursive: true });
  cpSync(
    join(realRerankerLocalDir, "..", "..", "tsconfig.base.json"),
    join(stageRoot, "tsconfig.base.json"),
  );
  return stagedPkg;
}

/** `bun install --frozen-lockfile && bun run build` — the same two commands the original in-place
 *  tests ran, just pointed at the staged copy. Returns the built entry file's absolute path. */
export function buildStagedRerankerLocal(stagedPkg: string): string {
  execFileSync("bun", ["install", "--frozen-lockfile"], { cwd: stagedPkg, stdio: "pipe" });
  execFileSync("bun", ["run", "build"], { cwd: stagedPkg, stdio: "pipe" });
  return join(stagedPkg, "dist", "index.js");
}

// --- The REAL checkout: reuse-as-is-or-build-and-leave (doctor-cli-bundle-reranker-resolution.
// test.ts's own rule for packages/shared/dist) --------------------------------------------------
//
// The ladder's automatic "route (iii), no config at all" resolution is inherently tied to the REAL
// packages/reranker-local/dist — registry.ts computes that path once, from its own real
// `import.meta.url`, with no per-call override (see resolveSourceCheckoutLocalRerankerPath's doc
// comment). Skipping that assertion whenever the real dist happened to be absent (the ORIGINAL fix
// for this ticket) meant it never ran on CI at all, since a fresh checkout never has one prebuilt —
// silently dropping the one piece of coverage that proves the real, un-injected source-checkout
// path actually works. The right rule (matching how doctor-cli-bundle-reranker-resolution.test.ts
// already treats packages/shared/dist) is: reuse an existing real dist AS-IS, read-only; otherwise
// build it and LEAVE it — a built dist is the normal state of a checkout, never test debris to
// clean up. Never delete it either way.

const BUILD_LOCK_DIR_NAME = ".obtc-reranker-local-build.lock";
const STALE_LOCK_MS = 5 * 60 * 1000; // 5 minutes — long enough for a real bun install + tsc
const LOCK_POLL_MS = 100;
const LOCK_WAIT_BUDGET_MS = 120_000; // ~120s, matching this repo's usual build-step timeouts

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cross-PROCESS mutex via an atomic `mkdirSync` (EEXIST when another process holds it) — vitest
 *  can run reranker-local-resolution.test.ts and reranker-auto-select.test.ts in separate worker
 *  processes, and both may reach "real dist missing, build it" at the same moment. Polls every
 *  100ms for up to ~120s; a lock dir older than 5 minutes is treated as abandoned (a killed process
 *  never got to clean up in its `finally`) and reclaimed rather than waited out forever. */
async function withRealRerankerLocalBuildLock<T>(
  realRerankerLocalDir: string,
  fn: () => T,
): Promise<T> {
  const lockDir = join(realRerankerLocalDir, BUILD_LOCK_DIR_NAME);
  const deadline = Date.now() + LOCK_WAIT_BUDGET_MS;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break; // acquired
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let ageMs = Number.POSITIVE_INFINITY;
      try {
        ageMs = Date.now() - statSync(lockDir).mtimeMs;
      } catch (statErr) {
        if ((statErr as NodeJS.ErrnoException).code === "ENOENT") continue; // vanished — retry now
        throw statErr;
      }
      if (ageMs > STALE_LOCK_MS) {
        rmSync(lockDir, { recursive: true, force: true }); // abandoned — reclaim and retry now
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `timed out after ${LOCK_WAIT_BUDGET_MS}ms waiting for the packages/reranker-local build lock (${lockDir}) — still held by another process`,
        );
      }
      await sleep(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/** Reuses the real `packages/reranker-local/dist/index.js` read-only when it already exists;
 *  otherwise builds it there (behind the lock above) and leaves it — never deletes it either way.
 *  Returns the built entry file's absolute path once this resolves; throws if a build ran but
 *  still didn't produce it. */
export async function ensureRealRerankerLocalDist(realRerankerLocalDir: string): Promise<string> {
  const distEntry = join(realRerankerLocalDir, "dist", "index.js");
  if (existsSync(distEntry)) return distEntry;
  return withRealRerankerLocalBuildLock(realRerankerLocalDir, () => {
    if (existsSync(distEntry)) return distEntry; // built by whoever held the lock before us
    execFileSync("bun", ["install", "--frozen-lockfile"], {
      cwd: realRerankerLocalDir,
      stdio: "pipe",
    });
    execFileSync("bun", ["run", "build"], { cwd: realRerankerLocalDir, stdio: "pipe" });
    if (!existsSync(distEntry)) {
      throw new Error(`bun run build in ${realRerankerLocalDir} did not produce ${distEntry}`);
    }
    return distEntry;
  });
}
