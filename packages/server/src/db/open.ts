import { chmodSync, closeSync, existsSync, openSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { Database, OpenOptions } from "./types";

function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/**
 * Open a SQLite-backed Database for the current runtime: bun:sqlite under Bun,
 * better-sqlite3 under Node. Adapters are imported dynamically so the inactive
 * runtime's native module is never evaluated. node:sqlite is the last-resort fallback when
 * better-sqlite3 cannot be resolved (e.g. the packed .mcpb); CI's Node 24 legs remove better-sqlite3
 * so the suite also runs on it.
 *
 * @param busyTimeoutMs THE-935: config's `db.busyTimeoutMs`, forwarded to whichever adapter opens
 *   the connection. Omitted falls back to DEFAULT_BUSY_TIMEOUT_MS (pragmas.ts).
 * @param opts THE-1039 fix round 1 (F2): `{ readonly: true }` opens `SQLITE_OPEN_READONLY` and
 *   skips every write-capable pragma (`journal_mode` chief among them) — for a caller that only
 *   ever means to INSPECT a database (`compact --dry-run`, `--into`'s live-side read, doctor's
 *   `probeDbSpace`), never to change its bytes or its journal mode as a side effect of looking.
 */
export async function openDatabase(
  path: string,
  busyTimeoutMs?: number,
  opts: OpenOptions = {},
): Promise<Database> {
  if (isBun()) {
    const { openBunSqlite } = await import("./bun-sqlite");
    return openBunSqlite(path, busyTimeoutMs, opts);
  }
  // Node: prefer better-sqlite3 (native, fastest). Fall back to the built-in node:sqlite ONLY when
  // better-sqlite3 cannot be resolved — e.g. the self-contained .mcpb bundle, which ships no
  // node_modules. A genuine DB error is not swallowed; only a resolution/binding failure falls back.
  try {
    const { openBetterSqlite3 } = await import("./node-better-sqlite3");
    return await openBetterSqlite3(path, busyTimeoutMs, opts);
  } catch (err) {
    if (!isBetterSqlite3Unavailable(err)) throw err;
    const { openNodeSqlite } = await import("./node-node-sqlite");
    return openNodeSqlite(path, busyTimeoutMs, opts);
  }
}

/**
 * THE-935 fix round 1: the ONE seam a config-scoped caller opening `<cacheDir>/<filename>` should
 * go through, so a future call site cannot silently forget `cfg.db.busyTimeoutMs` the way ~19 call
 * sites originally did (bare `openDatabase(join(cfg.cacheDir, filename))`, always the default).
 * Structural, not a reminder: the parameter is `cfg` itself, not a number a caller could omit —
 * `packages/server/test/db-busy-timeout-inventory.test.ts` also source-scans every remaining
 * direct `openDatabase(` call site under `src/` and fails the build on a new one that drops the
 * second argument, for the sites (doctor's probes, note-summary-scale, the sandbox VACUUM INTO
 * stage) that only ever hold a bare `cacheDir` string, not a full `ServerConfig`, and so cannot
 * route through this helper.
 */
export async function openConfiguredDatabase(
  cfg: Pick<ServerConfig, "cacheDir" | "db">,
  filename: string,
  opts: OpenOptions = {},
): Promise<Database> {
  const path = join(cfg.cacheDir, filename);
  if (!opts.ownerOnly || opts.readonly) return openDatabase(path, cfg.db.busyTimeoutMs, opts);
  // SQLite gives a new -wal/-shm the mode of the main file, so creating that one 0600 first covers
  // every sidecar born later. Files a previous version left looser are tightened before any open.
  if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
  const tightened = ["", "-wal", "-shm"]
    .map((suffix) => path + suffix)
    .filter(isLooserThanOwnerOnly);
  for (const file of tightened) chmodSync(file, 0o600);
  if (tightened.length > 0) {
    process.stderr.write(
      `[db] tightened ${tightened.join(", ")} to 0600 (owner-only): they were readable by group or other\n`,
    );
  }
  return openDatabase(path, cfg.db.busyTimeoutMs, opts);
}

/** Does group or other have a bit on an existing file? Windows has no such mode bits, so it never
 *  does there: a chmod would only toggle the read-only flag. Predicate only: the caller chmods. */
function isLooserThanOwnerOnly(path: string): boolean {
  if (process.platform === "win32" || !existsSync(path)) return false;
  return (statSync(path).mode & 0o077) !== 0;
}

function isBetterSqlite3Unavailable(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /cannot find (module|package)|could not locate the bindings|better[_-]?sqlite3/i.test(msg);
}
