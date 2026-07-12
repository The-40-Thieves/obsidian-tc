import type { Database } from "./types";

function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/**
 * Open a SQLite-backed Database for the current runtime: bun:sqlite under Bun,
 * better-sqlite3 under Node. Adapters are imported dynamically so the inactive
 * runtime's native module is never evaluated. node:sqlite is the last-resort fallback when
 * better-sqlite3 cannot be resolved (e.g. the packed .mcpb); it is also what the test suite runs on.
 */
export async function openDatabase(path: string): Promise<Database> {
  if (isBun()) {
    const { openBunSqlite } = await import("./bun-sqlite");
    return openBunSqlite(path);
  }
  // Node: prefer better-sqlite3 (native, fastest). Fall back to the built-in node:sqlite ONLY when
  // better-sqlite3 cannot be resolved — e.g. the self-contained .mcpb bundle, which ships no
  // node_modules. A genuine DB error is not swallowed; only a resolution/binding failure falls back.
  try {
    const { openBetterSqlite3 } = await import("./node-better-sqlite3");
    return await openBetterSqlite3(path);
  } catch (err) {
    if (!isBetterSqlite3Unavailable(err)) throw err;
    const { openNodeSqlite } = await import("./node-node-sqlite");
    return openNodeSqlite(path);
  }
}

function isBetterSqlite3Unavailable(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /cannot find (module|package)|could not locate the bindings|better[_-]?sqlite3/i.test(msg);
}
