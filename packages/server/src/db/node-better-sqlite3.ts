import type { Database as Db, RunResult } from "./types";

/**
 * Node runtime adapter over better-sqlite3 (synchronous, production-grade, no
 * flag). Sets the per-connection PRAGMAs the migration header expects.
 *
 * better-sqlite3 is imported dynamically *inside* this function and kept
 * external from the bundle (`bun build --external better-sqlite3`), never as a
 * static top-level import, on purpose. It is a native module: better-sqlite3
 * locates its compiled `better_sqlite3.node` with `bindings()`, which walks up
 * from the *calling module's* directory. If better-sqlite3 were inlined into
 * dist/cli.js, that lookup would start at packages/server/ and never reach the
 * real binary under node_modules/better-sqlite3/build/Release, crashing Node
 * with "Could not locate the bindings file". Keeping it external means the
 * import resolves to node_modules at runtime, so `bindings()` finds the binary;
 * keeping it lazy (mirroring the bun:sqlite adapter) means the module is only
 * evaluated when Node actually calls this adapter, so the Bun runtime never
 * loads better-sqlite3 (it uses bun:sqlite instead). Every caller reaches this
 * through the async openDatabase(), so the sync -> async change is transparent.
 */
export async function openBetterSqlite3(path: string): Promise<Db> {
  const { default: BetterSqlite3 } = await import("better-sqlite3");
  const db = new BetterSqlite3(path);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  return {
    exec: (sql: string): void => {
      db.exec(sql);
    },
    prepare: (sql: string) => {
      const st = db.prepare(sql);
      return {
        run: (...params: unknown[]): RunResult => st.run(...params) as RunResult,
        get: (...params: unknown[]): unknown => st.get(...params),
        all: (...params: unknown[]): unknown[] => st.all(...params),
      };
    },
    loadExtension: (extPath: string): void => {
      db.loadExtension(extPath);
    },
    close: (): void => {
      db.close();
    },
  };
}
