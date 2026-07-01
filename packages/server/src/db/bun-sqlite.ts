import type { Database as Db, RunResult, Statement } from "./types";

/**
 * Bun runtime adapter over the built-in bun:sqlite (synchronous, no flag, no
 * native install). Sets the per-connection PRAGMAs the migration header expects.
 *
 * bun:sqlite is imported dynamically *inside* this function, never as a static
 * top-level import, on purpose. `bun build --target node` inlines open.ts's
 * dynamic import("./bun-sqlite") into the bundle; a static
 * `import ... from "bun:sqlite"` would then be hoisted to the top of the
 * node-targeted dist/cli.js + dist/index.js and crash Node's ESM loader at load
 * time (ERR_UNSUPPORTED_ESM_URL_SCHEME, protocol 'bun:') — before the isBun()
 * guard in openDatabase can run. Keeping the import() inside the body means the
 * bun: specifier is only evaluated when Bun actually calls openBunSqlite, so the
 * same bundle also loads under Node (which then uses the better-sqlite3 adapter).
 */
export async function openBunSqlite(path: string): Promise<Db> {
  // @ts-expect-error bun:sqlite resolves only under the Bun runtime; this module
  // is imported (and this line reached) only when openDatabase detects Bun.
  const { Database: BunDatabase } = await import("bun:sqlite");
  const db = new BunDatabase(path, { create: true });
  // Server-tuned per-connection baseline (THE-273): WAL + synchronous=NORMAL is the documented
  // safe pairing; busy_timeout waits instead of throwing SQLITE_BUSY when the reindex, the boot
  // reconcile, and a live tool call touch cache.db at once; the larger page cache + mmap keep the
  // brute-force scan and the recursive graph walk resident.
  for (const p of [
    "PRAGMA foreign_keys = ON",
    "PRAGMA journal_mode = WAL",
    "PRAGMA synchronous = NORMAL",
    "PRAGMA busy_timeout = 5000",
    "PRAGMA cache_size = -32000",
    "PRAGMA temp_store = MEMORY",
    "PRAGMA mmap_size = 268435456",
  ])
    db.exec(p);
  const make = (sql: string): Statement => {
    const st = db.prepare(sql);
    return {
      run: (...params: unknown[]): RunResult => st.run(...params) as RunResult,
      get: (...params: unknown[]): unknown => st.get(...params) ?? undefined,
      all: (...params: unknown[]): unknown[] => st.all(...params),
    };
  };
  // bun:sqlite's db.prepare is UNCACHED (fresh Statement each call) — memoize the compiled
  // statement by SQL text so the per-dispatch audit + idempotency statements are parsed once.
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
