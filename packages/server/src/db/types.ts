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
  /** THE-1039 fix round 3 (C2) — set only when this connection was opened with
   *  `{ readonly: true }`: which of the two open strategies the adapter actually used.
   *  `"native"` means the OS-level `SQLITE_OPEN_READONLY` open succeeded — bytes and journal mode
   *  are guaranteed unchanged. `"fallback"` means that open THREW and the adapter fell back to a
   *  writable file descriptor that merely issues no write statement — see pragmas.ts's
   *  `readonlyConnectionPragmas` and each adapter's own comment for why that fallback can still
   *  physically mutate the file (SQLite's checkpoint-on-close against a dangling WAL) despite never
   *  being asked to. Exposed so a test can assert which path a given fixture took, rather than
   *  inferring it from side effects. `undefined` under a non-readonly open. */
  readonlyMode?: "native" | "fallback";
}

/**
 * THE-1039 — every `openDatabase`/adapter-open call site's third parameter. `readonly: true`
 * applies `pragmas.ts`'s `readonlyConnectionPragmas` instead of the writer set (never a pragma
 * capable of writing — chiefly `journal_mode`) and refuses to CREATE a missing file where the
 * adapter supports that distinctly from opening read-only.
 *
 * Fix round 2 (C1) tried dropping each adapter's native `SQLITE_OPEN_READONLY` open mode entirely
 * — fix round 1 used it, and CI's `build-test (macos-latest)` failed opening a WAL-mode fixture
 * that way ("unable to open database file") while Linux x64/arm64 and Windows passed unchanged;
 * see bun-sqlite.ts's comment for the full incident. That "always use a writable fd" fix was ITSELF
 * found unsafe (fix round 3, C2): a writable file descriptor cannot stop SQLite performing its own
 * checkpoint-on-close if this connection happens to be the one that closes a DANGLING, un-
 * checkpointed WAL (left by a writer that crashed or was killed) — a PHYSICAL mutation of the main
 * file's bytes and deletion of `-wal`, entirely outside any pragma this code chooses to issue.
 *
 * Current fix (round 3): READONLY-FIRST WITH FALLBACK. Every adapter tries the native
 * `SQLITE_OPEN_READONLY` open FIRST; only if that throws does it fall back to a writable file
 * descriptor that issues no write statement. `Database.readonlyMode` (above) says which path a
 * given open actually took. The guarantee this now provides is conditional, not absolute: when the
 * native open succeeds, this is no logical or configuration change to the file — bytes and journal
 * mode are unchanged. When it does not and the fallback is used, bytes MAY change (the
 * checkpoint-on-close case above) even though no write statement was issued — see each adapter's
 * own comment.
 */
export interface OpenOptions {
  readonly?: boolean;
}

/** prepareCached when the adapter provides it (production bun / better-sqlite3), else prepare. */
export function cachedPrepare(db: Database, sql: string): Statement {
  return db.prepareCached ? db.prepareCached(sql) : db.prepare(sql);
}
