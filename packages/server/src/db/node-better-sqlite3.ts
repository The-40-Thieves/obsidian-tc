import { connectionPragmas, readonlyConnectionPragmas } from "./pragmas";
import type { Database as Db, OpenOptions, RunResult, Statement } from "./types";

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
export async function openBetterSqlite3(
  path: string,
  busyTimeoutMs?: number,
  opts: OpenOptions = {},
): Promise<Db> {
  const { default: BetterSqlite3 } = await import("better-sqlite3");
  // THE-1039 fix round 2 (C1) — see bun-sqlite.ts's matching comment for the full macOS incident
  // this reverts (fix round 1's F2 used the native `readonly` option, which CI's macOS leg failed
  // to open a WAL-mode fixture with, while Linux/Windows passed unchanged). `opts.readonly` now
  // maps to `{ fileMustExist: true }` WITHOUT `readonly` — per better-sqlite3's own source
  // (src/objects/database.cpp): `readonly ? SQLITE_OPEN_READONLY : must_exist ?
  // SQLITE_OPEN_READWRITE : (SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE)` — so this opens a normal
  // READWRITE file descriptor (sidesteps whatever macOS-specific SQLITE_OPEN_READONLY + WAL/`-shm`
  // restriction bit bun:sqlite) while still refusing to CREATE a missing file. Never issuing a
  // write statement (readonlyConnectionPragmas below, no INSERT/UPDATE/PRAGMA-that-sets-a-value)
  // is what actually keeps this "read-only" in the sense that matters — the file descriptor's own
  // OS-level permission was always redundant defense, not the primary guarantee.
  const db = opts.readonly
    ? new BetterSqlite3(path, { fileMustExist: true })
    : new BetterSqlite3(path);
  // Server-tuned per-connection baseline (THE-273), shared with the other adapters so the ORDER
  // cannot drift between them — busy_timeout must precede anything that can contend (THE-745).
  // See db/pragmas.ts. better-sqlite3 caches statements internally, so prepareCached here mainly
  // bounds wrapper allocation (the real win is on bun:sqlite). busyTimeoutMs is forwarded rather
  // than called bare (THE-935) so config's db.busyTimeoutMs reaches this connection instead of
  // silently falling back to the default. readonly gets the writer-pragma-free subset — see
  // readonlyConnectionPragmas' comment.
  for (const p of opts.readonly
    ? readonlyConnectionPragmas(busyTimeoutMs)
    : connectionPragmas(busyTimeoutMs))
    db.pragma(p);
  const make = (sql: string): Statement => {
    const st = db.prepare(sql);
    return {
      run: (...params: unknown[]): RunResult => st.run(...params) as RunResult,
      get: (...params: unknown[]): unknown => st.get(...params),
      all: (...params: unknown[]): unknown[] => st.all(...params),
    };
  };
  const cache = new Map<string, Statement>();
  return {
    exec: (sql: string): void => {
      db.exec(sql);
    },
    prepare: make,
    prepareCached: (sql: string): Statement => {
      const hit = cache.get(sql);
      if (hit) return hit;
      const st = make(sql);
      cache.set(sql, st);
      return st;
    },
    loadExtension: (extPath: string): void => {
      db.loadExtension(extPath);
    },
    close: (): void => {
      db.close();
    },
  };
}
