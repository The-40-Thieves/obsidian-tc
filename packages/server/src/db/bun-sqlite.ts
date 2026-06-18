// @ts-expect-error bun:sqlite resolves only under the Bun runtime; openDatabase
// imports this module dynamically and only when running on Bun.
import { Database as BunDatabase } from "bun:sqlite";
import type { Database as Db, RunResult } from "./types";

/**
 * Bun runtime adapter over the built-in bun:sqlite (synchronous, no flag, no
 * native install). Sets the per-connection PRAGMAs the migration header expects.
 */
export function openBunSqlite(path: string): Db {
  const db = new BunDatabase(path, { create: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  return {
    exec: (sql: string): void => {
      db.exec(sql);
    },
    prepare: (sql: string) => {
      const st = db.prepare(sql);
      return {
        run: (...params: unknown[]): RunResult => st.run(...params) as RunResult,
        get: (...params: unknown[]): unknown => st.get(...params) ?? undefined,
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
