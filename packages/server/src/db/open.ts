import { join } from "node:path";
import type { ServerConfig } from "@the-40-thieves/obsidian-tc-shared";
import type { Database } from "./types";

function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/**
 * Open a SQLite-backed Database for the current runtime: bun:sqlite under Bun,
 * better-sqlite3 under Node. Adapters are imported dynamically so the inactive
 * runtime's native module is never evaluated. node:sqlite is the last-resort fallback when
 * better-sqlite3 cannot be resolved (e.g. the packed .mcpb); it is also what the test suite runs on.
 *
 * @param busyTimeoutMs THE-935: config's `db.busyTimeoutMs`, forwarded to whichever adapter opens
 *   the connection. Omitted falls back to DEFAULT_BUSY_TIMEOUT_MS (pragmas.ts).
 */
export async function openDatabase(path: string, busyTimeoutMs?: number): Promise<Database> {
  if (isBun()) {
    const { openBunSqlite } = await import("./bun-sqlite");
    return openBunSqlite(path, busyTimeoutMs);
  }
  // Node: prefer better-sqlite3 (native, fastest). Fall back to the built-in node:sqlite ONLY when
  // better-sqlite3 cannot be resolved — e.g. the self-contained .mcpb bundle, which ships no
  // node_modules. A genuine DB error is not swallowed; only a resolution/binding failure falls back.
  try {
    const { openBetterSqlite3 } = await import("./node-better-sqlite3");
    return await openBetterSqlite3(path, busyTimeoutMs);
  } catch (err) {
    if (!isBetterSqlite3Unavailable(err)) throw err;
    const { openNodeSqlite } = await import("./node-node-sqlite");
    return openNodeSqlite(path, busyTimeoutMs);
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
): Promise<Database> {
  return openDatabase(join(cfg.cacheDir, filename), cfg.db.busyTimeoutMs);
}

function isBetterSqlite3Unavailable(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /cannot find (module|package)|could not locate the bindings|better[_-]?sqlite3/i.test(msg);
}
