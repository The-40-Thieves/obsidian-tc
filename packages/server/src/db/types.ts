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
  // Load a SQLite loadable extension (sqlite-vec). Present only on adapters whose
  // runtime supports it (better-sqlite3, bun:sqlite); absent under node:sqlite,
  // where callers fall back to the in-process brute-force vector scan.
  loadExtension?(path: string): void;
  close?(): void;
}
