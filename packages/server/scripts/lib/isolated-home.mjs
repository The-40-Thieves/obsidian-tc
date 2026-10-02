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

/** A throwaway home under the real (symlink-resolved) tmpdir, removed on `cleanup()` or at exit.
 *  `env` is the full set of overrides to merge over `process.env` for a spawned child. */
export function createIsolatedHome(prefix) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const cleanup = () =>
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
