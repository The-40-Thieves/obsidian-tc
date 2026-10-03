// Windows safety net for `stageSandbox`'s staged temp directories (workspace/rerun.ts). On POSIX a
// process exit reclaims every open file descriptor, so an unremoved staged copy is at worst a disk
// leak until the box is rebooted; on Windows an open handle BLOCKS the unlink outright (no
// FILE_SHARE_DELETE by default), which is why `rmSync`'s own bounded retries in `safeDispose`
// (workspace/rerun.ts) are not always enough — a handle that only frees up a moment later still
// needs the removal to happen, without the original caller having to notice or retry itself.
//
// Two independent nets:
//
//   1. `scheduleDeferredCleanup` — a bounded, unref'd background retry for the ONE directory
//      `safeDispose` just failed to remove synchronously.
//   2. `sweepStaleSandboxDirs` — a floor under (1): anything still left behind (a crashed process,
//      a deferred retry that itself gave up) ages out of `os.tmpdir()` the next time ANY rerun
//      runs, sandbox or CLI. Bounded to entries whose name matches `stageSandbox`'s own mint shape
//      exactly and whose mtime is older than `maxAgeMs` — never a dir this process, or a sibling
//      rerun running concurrently, just created.
//
// `awaitPendingSandboxCleanup()` is a test hook only: production code never needs to know when a
// deferred retry settles, but a test asserting "no leaked dir" needs a way to flush (1)'s real
// backoff timers before it can trust a negative result.

import {
  lstatSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** `stageSandbox`'s own `mkdtempSync` prefix — the one source of truth both the mint site
 *  (workspace/rerun.ts) and this module's sweep/retry logic read, so they cannot drift apart. */
export const RERUN_TMP_PREFIX = "obtc-rerun-";
export const RERUN_LIVE_MARKER = ".obtc-rerun-active";
const HEARTBEAT_INTERVAL_MS = 30_000;

/** `mkdtempSync`'s suffix is plain alphanumeric appended with no separator — matches EXACTLY what
 *  `stageSandbox` mints, and deliberately excludes this repo's other, differently-suffixed
 *  `obtc-rerun-*` fixture dirs (e.g. test-only `obtc-rerun-cache-...`). A sweep or retry touching
 *  one of those would be reaching outside what THIS module ever created. */
const RERUN_TMP_NAME_RE = /^obtc-rerun-[a-zA-Z0-9]+$/;

const DEFAULT_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000] as const;

/** Every deferred-cleanup attempt currently in flight, keyed by nothing — `awaitPendingSandboxCleanup`
 *  only ever needs "have they all settled", never which path a given entry belongs to. */
const pending = new Set<Promise<void>>();

interface DeferredCleanupDeps {
  /** Throws on failure, same contract as `rmSync`. Overridable only for this module's own unit
   *  tests — every real caller gets the `rmSync`-backed default. */
  remove: (path: string) => void;
  delaysMs: readonly number[];
}

const defaultDeps: DeferredCleanupDeps = {
  remove: (path) => rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  delaysMs: DEFAULT_RETRY_DELAYS_MS,
};

/** Keep a staged sandbox visibly live to cleanup sweeps, including runs lasting over an hour. */
export function touchSandboxHeartbeat(base: string): void {
  const marker = join(base, RERUN_LIVE_MARKER);
  try {
    const st = lstatSync(marker);
    if (!st.isFile() || st.isSymbolicLink()) return;
    const now = new Date();
    utimesSync(marker, now, now);
  } catch {
    // Disposal may remove the marker while a queued heartbeat is settling.
  }
}

export function startSandboxHeartbeat(base: string): () => void {
  const marker = join(base, RERUN_LIVE_MARKER);
  writeFileSync(marker, `${process.pid}\n`, { flag: "wx" });
  const timer = setInterval(() => touchSandboxHeartbeat(base), HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    try {
      unlinkSync(marker);
    } catch {
      // The sandbox may already have been disposed.
    }
  };
}

function hasFreshHeartbeat(base: string, now: number, maxAgeMs: number): boolean {
  try {
    const st = lstatSync(join(base, RERUN_LIVE_MARKER));
    return st.isFile() && !st.isSymbolicLink() && now - st.mtimeMs < maxAgeMs;
  } catch {
    return false;
  }
}

/**
 * Retry removing `base` in the background, on an increasing backoff, without blocking the caller
 * that already failed once (`safeDispose`). Every timer is `unref()`'d — a rerun that already
 * returned its result to the caller must not be kept alive by a leftover retry loop.
 *
 * `deps` is test-only wiring (a fake `remove` + short delays); every production call site uses the
 * default `rmSync`-backed remover and the real backoff.
 */
export function scheduleDeferredCleanup(
  base: string,
  deps: Partial<DeferredCleanupDeps> = {},
): void {
  const { remove, delaysMs } = { ...defaultDeps, ...deps };
  let resolveSettled = (): void => {};
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  pending.add(settled);
  settled.finally(() => pending.delete(settled));

  const attempt = (i: number): void => {
    setTimeout(() => {
      try {
        remove(base);
        resolveSettled();
      } catch (e) {
        if (i + 1 < delaysMs.length) {
          attempt(i + 1);
          return;
        }
        process.stderr.write(
          `rerun: warning: gave up removing staged sandbox directory ${base} after ` +
            `${delaysMs.length} deferred retries: ${(e as Error).message}\n`,
        );
        resolveSettled();
      }
    }, delaysMs[i]).unref();
  };
  attempt(0);
}

/**
 * Register a sandbox's own close-then-dispose chain (runtime/session-rerun-sandbox.ts) that its
 * caller did not wait for — a timed-out `session_rerun` returns to the caller at its deadline and
 * leaves this chain running — so `awaitPendingSandboxCleanup` also covers it. `cleanup` must never
 * reject; it is tracked, not awaited, by production code.
 */
export function trackPendingSandboxCleanup(cleanup: Promise<void>): void {
  pending.add(cleanup);
  cleanup.finally(() => pending.delete(cleanup));
}

/** Test hook — resolves once every deferred cleanup CURRENTLY scheduled (including any that
 *  reschedule themselves while this is awaited) has settled, success or exhausted-retries alike.
 *  Never called by production code. */
export async function awaitPendingSandboxCleanup(): Promise<void> {
  while (pending.size > 0) {
    await Promise.all(pending);
  }
}

/**
 * Remove any `obtc-rerun-*` staging directory left behind by a past run, still sitting in
 * `os.tmpdir()` past `maxAgeMs`. Called at the start of every rerun (session_rerun's MCP tool,
 * `rerun --sandbox`) — not on a timer of its own — so it never needs its own process lifetime and
 * costs nothing on a box that has never left one behind.
 *
 * Best-effort throughout: an unreadable tmp dir, an entry that disappears mid-sweep (a sibling
 * process's own cleanup), or a removal that still fails are all swallowed — this sweep must never
 * be the reason a rerun itself fails, only a net under the two things that usually already work.
 */
export function sweepStaleSandboxDirs(
  opts: { tmpDir?: string; maxAgeMs?: number; now?: number } = {},
): void {
  const dir = opts.tmpDir ?? tmpdir();
  const maxAgeMs = opts.maxAgeMs ?? 24 * 60 * 60 * 1000; // 24 hours
  const now = opts.now ?? Date.now();

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const name of entries) {
    if (!RERUN_TMP_NAME_RE.test(name)) continue;
    const full = join(dir, name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs < maxAgeMs) continue;
    if (hasFreshHeartbeat(full, now, maxAgeMs)) continue;
    try {
      if (hasFreshHeartbeat(full, now, maxAgeMs)) continue;
      rmSync(full, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (e) {
      process.stderr.write(
        `rerun: warning: stale-sandbox sweep failed to remove ${full}: ${(e as Error).message}\n`,
      );
    }
  }
}
