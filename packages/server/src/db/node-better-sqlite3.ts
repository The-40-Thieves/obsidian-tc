import BetterSqlite3 from "better-sqlite3";
import type { Database as Db, RunResult } from "./types";

/**
 * Node runtime adapter over better-sqlite3 (synchronous, production-grade, no
 * flag). Sets the per-connection PRAGMAs the migration header expects.
 */
export function openBetterSqlite3(path: string): Db {
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
    close: (): void => {
      db.close();
    },
  };
}
