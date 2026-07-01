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
  /** Like prepare(), but memoizes the compiled Statement by SQL text on the connection.
   *  Use ONLY for STATIC SQL (audit / idempotency hot paths); never for dynamic IN(?,?,...)
   *  arity, which would grow the cache unboundedly. Optional: the node:sqlite test path omits
   *  it and cachedPrepare() falls back to prepare(). bun:sqlite's db.prepare is uncached, so
   *  this is where the win lands. */
  prepareCached?(sql: string): Statement;
  // Load a SQLite loadable extension (sqlite-vec). Present only on adapters whose
  // runtime supports it (better-sqlite3, bun:sqlite); absent under node:sqlite,
  // where callers fall back to the in-process brute-force vector scan.
  loadExtension?(path: string): void;
  close?(): void;
}

/** prepareCached when the adapter provides it (production bun / better-sqlite3), else prepare. */
export function cachedPrepare(db: Database, sql: string): Statement {
  return db.prepareCached ? db.prepareCached(sql) : db.prepare(sql);
}
