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

/**
 * THE-1039 — every `openDatabase`/adapter-open call site's third parameter. `readonly: true`
 * applies `pragmas.ts`'s `readonlyConnectionPragmas` instead of the writer set (never a pragma
 * capable of writing — chiefly `journal_mode`) and refuses to CREATE a missing file where the
 * adapter supports that distinctly from opening read-only.
 *
 * Fix round 2 (C1): does NOT use each adapter's native `SQLITE_OPEN_READONLY` open mode anymore.
 * Fix round 1 did, and CI's `build-test (macos-latest)` failed opening a WAL-mode fixture that way
 * — "unable to open database file" — while Linux x64/arm64 and Windows passed unchanged; see
 * bun-sqlite.ts's comment for the full incident. Every adapter now opens a normal READWRITE file
 * descriptor under `readonly: true` and simply never issues a write statement — see each adapter's
 * own comment for why that is the actual guarantee, not the OS-level open flag.
 */
export interface OpenOptions {
  readonly?: boolean;
}

/** prepareCached when the adapter provides it (production bun / better-sqlite3), else prepare. */
export function cachedPrepare(db: Database, sql: string): Statement {
  return db.prepareCached ? db.prepareCached(sql) : db.prepare(sql);
}
