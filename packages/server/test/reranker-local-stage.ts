// GH #958 / THE-1085: reranker-local-resolution.test.ts and reranker-auto-select.test.ts both need
// a REAL, `tsc`-built copy of packages/reranker-local to exercise the resolution ladder's
// non-stubbed mechanics (a stub resolver is what let the original THE-705/THE-944 bugs ship
// unnoticed — see those files' own headers). They used to build that copy IN PLACE, in the real
// `packages/reranker-local/dist` — a developer's own build, unconditionally `rm -rf`'d in
// beforeAll/afterAll, and racy besides: vitest runs test files in parallel, and both files touched
// the same directory.
//
// This helper offers three ways to get what those files need without that hazard:
//
//   - `stageRerankerLocalSource` + `buildStagedRerankerLocal` copy the package's SOURCE (no
//     node_modules, no dist — the "unbuilt checkout" shape) into a caller-supplied temp root and
//     build it there. Each caller passes its own `mkdtempSync`-generated root, so two files staging
//     in parallel can never collide. Used for every "built" assertion EXCEPT the one below.
//   - `ensureRealRerankerLocalDist` is for the one case that is inherently tied to the REAL,
//     fixed checkout path (registry.ts's automatic "route iii, no config" resolution — see its own
//     comment further down): reuse the real dist read-only when present, else build it IN PLACE,
//     behind a cross-process lock, and leave it — never delete it.
//   - `writeRerankerLocalAnchorOnly` writes just the `packages/reranker-local/package.json` anchor
//     (no dist) under a caller-supplied temp root — the "not built at all" shape, for a NEGATIVE
//     case that must stay independent of the real checkout's on-disk state (GH #958 review round 2,
//     finding 1: the real dist may be getting built-and-left by a concurrently running sibling file
//     at the exact moment a "not built" assertion runs).
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

const REAL_RERANKER_LOCAL_PACKAGE_NAME = "@the-40-thieves/obsidian-tc-reranker-local";

/** Writes ONLY the anchor `packages/reranker-local/package.json` (correct name; no dist, no
 *  node_modules) under `root` — the "not built at all" shape
 *  `resolveSourceCheckoutLocalRerankerPath`'s upward walk is meant to find. Returns a nested
 *  directory a few levels below the anchor to pass as that function's `startDir`, mirroring how
 *  the real production call site (packages/server/src/providers/registry.ts) sits several levels
 *  under the real repo root. */
export function writeRerankerLocalAnchorOnly(root: string): string {
  const pkgDir = join(root, "packages", "reranker-local");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    `${JSON.stringify({ name: REAL_RERANKER_LOCAL_PACKAGE_NAME })}\n`,
  );
  const startDir = join(root, "packages", "server", "src", "providers");
  mkdirSync(startDir, { recursive: true });
  return startDir;
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
// clean up. Never delete it either way. And if `dist/` exists but is INCOMPLETE (present directory,
// missing `index.js` — a developer's own partial/killed build), never build into it either: report
// "partial" so the caller can skip rather than risk `tsc` mixing outputs with whatever is there.

const BUILD_LOCK_DIR_NAME = ".obtc-reranker-local-build.lock";
const OWNER_FILE_NAME = "owner.json";
const HEARTBEAT_INTERVAL_MS = 10_000; // GH #958 review round 2, finding 2
const HEARTBEAT_STALE_MS = 60_000; // a lock is only "abandoned" past this, not merely "slow"
const LOCK_POLL_MS = 100;
const BUILD_STEP_TIMEOUT_MS = 180_000; // per subprocess (install, then build) — kill if it hangs
// Comfortably longer than the worst case a legitimate holder can take (two 180s-bounded steps
// plus polling slack) — a waiter must never time out before a holder's OWN build timeout would
// have fired first (review finding 2's second point).
const LOCK_WAIT_BUDGET_MS = 2 * BUILD_STEP_TIMEOUT_MS + 60_000;

interface LockOwner {
  pid: number;
  startedAt: number;
  heartbeatAt: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ownerFilePath(lockDir: string): string {
  return join(lockDir, OWNER_FILE_NAME);
}

function readOwner(lockDir: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(readFileSync(ownerFilePath(lockDir), "utf8")) as Partial<LockOwner>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.startedAt === "number" &&
      typeof parsed.heartbeatAt === "number"
    ) {
      return parsed as LockOwner;
    }
    return undefined; // malformed — treated the same as "missing" by every caller below
  } catch {
    return undefined;
  }
}

function writeOwner(lockDir: string, owner: LockOwner): void {
  writeFileSync(ownerFilePath(lockDir), JSON.stringify(owner));
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

/** A lock is stale — safe to reclaim — only when its owner process is confirmed DEAD, or its
 *  heartbeat has gone quiet for longer than `HEARTBEAT_STALE_MS` (GH #958 review round 2, finding
 *  2: directory `mtime` alone never advances during a live build, so it cannot tell "abandoned"
 *  from "still working" — an explicit, periodically-refreshed heartbeat can). A lock dir that has
 *  no readable `owner.json` yet (a holder that just `mkdirSync`'d it and hasn't written the file in
 *  the same tick) is NOT immediately stale — it falls back to the lock DIRECTORY's own mtime
 *  against the same staleness window, giving a legitimate acquirer time to finish writing it. */
function isLockStale(lockDir: string, nowMs: number): boolean {
  const owner = readOwner(lockDir);
  if (owner) {
    if (!isProcessAlive(owner.pid)) return true;
    return nowMs - owner.heartbeatAt > HEARTBEAT_STALE_MS;
  }
  try {
    return nowMs - statSync(lockDir).mtimeMs > HEARTBEAT_STALE_MS;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; // vanished — not ours to reclaim
    throw e;
  }
}

/** Cross-PROCESS mutex via an atomic `mkdirSync` (EEXIST when another process holds it) — vitest
 *  can run reranker-local-resolution.test.ts and reranker-auto-select.test.ts in separate worker
 *  processes, and both may reach "real dist missing, build it" at the same moment. Polls every
 *  100ms up to `LOCK_WAIT_BUDGET_MS`. While held, the owner's pid/heartbeat is recorded in
 *  `owner.json` and refreshed every `HEARTBEAT_INTERVAL_MS` for the duration of `fn` — a waiter
 *  only reclaims the lock once that heartbeat has gone stale (see `isLockStale`), and release
 *  (in `finally`) only removes the lock dir if `owner.json` still names OUR pid — a contender that
 *  reclaimed it as stale in the meantime keeps its own lock intact. */
async function withRealRerankerLocalBuildLock<T>(
  realRerankerLocalDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockDir = join(realRerankerLocalDir, BUILD_LOCK_DIR_NAME);
  const deadline = Date.now() + LOCK_WAIT_BUDGET_MS;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break; // acquired
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (isLockStale(lockDir, Date.now())) {
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

  const owner: LockOwner = { pid: process.pid, startedAt: Date.now(), heartbeatAt: Date.now() };
  writeOwner(lockDir, owner);
  const heartbeat = setInterval(() => {
    try {
      writeOwner(lockDir, { ...owner, heartbeatAt: Date.now() });
    } catch {
      // Best effort — if the lock dir is somehow already gone, the build itself still runs to
      // completion; whatever removed it is that contender's problem to reconcile, not ours.
    }
  }, HEARTBEAT_INTERVAL_MS);
  // Never let the interval itself keep the process alive (matters for a bare `node --test` runner;
  // vitest workers exit via other means, but this costs nothing either way).
  heartbeat.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    // Only remove the lock if we STILL own it — a contender may have reclaimed it as stale while
    // we were unexpectedly blocked past the heartbeat window; unconditional removal would then
    // delete THEIR lock instead of ours (review finding 2's core bug).
    const current = readOwner(lockDir);
    if (current?.pid === process.pid) {
      rmSync(lockDir, { recursive: true, force: true });
    }
  }
}

/** Runs one command asynchronously (so the event loop — and this module's heartbeat interval —
 *  keeps ticking while it's in flight; `execFileSync` blocks synchronously and would starve the
 *  heartbeat for the whole build), bounded by `BUILD_STEP_TIMEOUT_MS`: a hung subprocess is
 *  SIGKILL'd rather than holding the lock forever (GH #958 review round 2, finding 2). */
function runCommandAsync(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, BUILD_STEP_TIMEOUT_MS);
    child = spawn(cmd, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `${cmd} ${args.join(" ")} in ${cwd} timed out after ${BUILD_STEP_TIMEOUT_MS}ms and was killed`,
          ),
        );
      } else if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${cmd} ${args.join(" ")} in ${cwd} exited ${code}${signal ? ` (signal ${signal})` : ""}: ${stderr}`,
          ),
        );
      }
    });
  });
}

export type EnsureRealRerankerLocalDistResult =
  | { status: "ready"; path: string; built: boolean }
  | { status: "partial"; distDir: string };

/** Reuses the real `packages/reranker-local/dist/index.js` read-only when it already exists;
 *  otherwise builds it there (behind the lock above) and leaves it — never deletes it either way.
 *  If `dist/` exists but `index.js` does not (a partial/killed build already sitting there), never
 *  builds into it — returns `{ status: "partial" }` so the caller can skip its assertion instead of
 *  risking `tsc` mixing its output with whatever is already on disk. */
export async function ensureRealRerankerLocalDist(
  realRerankerLocalDir: string,
): Promise<EnsureRealRerankerLocalDistResult> {
  const distDir = join(realRerankerLocalDir, "dist");
  const distEntry = join(distDir, "index.js");
  if (existsSync(distEntry)) return { status: "ready", path: distEntry, built: false };
  if (existsSync(distDir)) return { status: "partial", distDir };

  return withRealRerankerLocalBuildLock(realRerankerLocalDir, async () => {
    // Re-check inside the lock: another process may have finished building (or the partial state
    // may have appeared) while we were waiting for it.
    if (existsSync(distEntry)) return { status: "ready" as const, path: distEntry, built: false };
    if (existsSync(distDir)) return { status: "partial" as const, distDir };

    await runCommandAsync("bun", ["install", "--frozen-lockfile"], realRerankerLocalDir);
    await runCommandAsync("bun", ["run", "build"], realRerankerLocalDir);
    if (!existsSync(distEntry)) {
      throw new Error(`bun run build in ${realRerankerLocalDir} did not produce ${distEntry}`);
    }
    return { status: "ready" as const, path: distEntry, built: true };
  });
}

// --- Whole-tree snapshot (GH #958 review round 2, finding 4) ------------------------------------

export interface DistFileSnapshot {
  relPath: string;
  size: number;
  mtimeMs: number;
}

/** Every FILE under `dir`, recursively, as `{relPath, size, mtimeMs}` sorted by `relPath` — `/`
 *  separators always, regardless of platform, so the snapshot compares identically on Windows.
 *  `null` when `dir` itself does not exist. Used to prove the real `packages/reranker-local/dist`
 *  is untouched byte-for-byte (not just its `index.js` file) across a test run that found it
 *  already built. */
export function snapshotDistTree(dir: string): DistFileSnapshot[] | null {
  if (!existsSync(dir)) return null;
  const out: DistFileSnapshot[] = [];
  const walk = (current: string, relPrefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = join(current, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        const st = statSync(abs);
        out.push({ relPath: rel, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  };
  walk(dir, "");
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return out;
}
