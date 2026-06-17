// Minimal synchronous DB surface shared by the runtime adapters
// (better-sqlite3 in Node, bun:sqlite in Bun) and node:sqlite in tests.
export interface RunResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}
export interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close?(): void;
}
