import type { Database } from "./types";

function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/**
 * Open a SQLite-backed Database for the current runtime: bun:sqlite under Bun,
 * better-sqlite3 under Node. Adapters are imported dynamically so the inactive
 * runtime's native module is never evaluated. node:sqlite is reserved for tests.
 */
export async function openDatabase(path: string): Promise<Database> {
  if (isBun()) {
    const { openBunSqlite } = await import("./bun-sqlite");
    return openBunSqlite(path);
  }
  const { openBetterSqlite3 } = await import("./node-better-sqlite3");
  return openBetterSqlite3(path);
}
