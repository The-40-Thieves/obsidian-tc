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
  // THE-687: an unconditional ignore, NOT `expect-error`, and the distinction is load-bearing.
  // This file is compiled by TWO projects with different `types`: the main one pins ["node"], where
  // bun:sqlite does not resolve and the suppression is REQUIRED; tsconfig.bun-smoke.json adds
  // "bun", where it DOES resolve and an `expect-error` would itself fail as an unused directive.
  // A directive that must hold under one configuration and not the other cannot be `expect-error`,
  // which asserts the error is always present.
  // bun:sqlite resolves only under the Bun runtime; this module is imported (and this line
  // reached) only when openDatabase detects Bun.
  // biome-ignore lint/suspicious/noTsIgnore: expect-error is unusable here (see above) — bun:sqlite resolves under the bun-smoke project but not the main one, so the suppression is conditional by construction.
  // @ts-ignore
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
    // THE-687: bun:sqlite types its bind parameters as SQLQueryBindings, while the Statement port
    // this adapter implements accepts `unknown[]` — the boundary is genuinely untyped, since the
    // caller's values come from arbitrary tool input. The cast is at that boundary and nowhere
    // else. Invisible under the main tsconfig (bun:sqlite is unresolved there, so `st` is `any`);
    // the bun-smoke project is the only one that checks these calls at all.
    const bind = (params: unknown[]) => params as never[];
    return {
      run: (...params: unknown[]): RunResult => st.run(...bind(params)) as RunResult,
      get: (...params: unknown[]): unknown => st.get(...bind(params)) ?? undefined,
      all: (...params: unknown[]): unknown[] => st.all(...bind(params)),
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
