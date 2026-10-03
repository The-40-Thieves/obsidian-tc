// One isolated "operator home" for any script that spawns the built CLI outside vitest (vitest
// pins HOME per worker in test/home-isolation-setup.ts; plain `bun scripts/*.ts` runs do not).
// Without it a child resolves `~/.obsidian-tc` against the REAL home, so a smoke run leaks state
// into the operator's cache and the next run trips the vault-identity conflict.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

/** Env overrides that point every home-derived location at `home` (POSIX, XDG and Windows). */
export function isolatedHomeEnv(home) {
  return {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
  };
}

/** Whether `path` is `root` or inside it. */
export function isUnder(path, root) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Remove a scratch tree, riding out a Windows handle that is still being released (a child that
 *  was just killed holds its cwd, its caches and any mapped file until the OS finishes tearing it
 *  down). Node's retry backoff is linear: 10 x 100 ms is ~5.5 s, spent only when something is held. */
export function removeTree(path) {
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** Resolves true once no process has `pid`, false if it is still there after `timeoutMs`. A child's
 *  stdio closing is NOT its exit: on Windows the process (and the handles it keeps on the scratch
 *  tree) can outlive its pipes, so "the client saw the transport close" must not gate the cleanup. */
export async function waitForPidExit(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err && err.code === "ESRCH") return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A throwaway home under the real (symlink-resolved) tmpdir, removed on `cleanup()` or at exit.
 *  `env` is the full set of overrides to merge over `process.env` for a spawned child. */
export function createIsolatedHome(prefix) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const cleanup = () => removeTree(root);
  process.once("exit", cleanup);
  return { root, home, env: isolatedHomeEnv(home), cleanup };
}

/** Throws unless the child put its default state dir (`<home>/.obsidian-tc/cache.db`) under
 *  `home`: proof the run resolved its state dir inside the isolated root, not the real home. */
export function assertStateUnderHome(home) {
  const db = join(home, ".obsidian-tc", "cache.db");
  if (!existsSync(db)) {
    throw new Error(
      `child did not create ${db}: its state dir did not resolve under the isolated home`,
    );
  }
  if (!isUnder(realpathSync(db), realpathSync(home))) {
    throw new Error(`${db} resolves outside the isolated home ${home}`);
  }
}
