import { connectionPragmas } from "./pragmas";
import type { Database as Db, RunResult, Statement } from "./types";

// Minimal shape of the built-in node:sqlite surface we use (typed locally so this compiles
// regardless of the @types/node node:sqlite typings version).
interface NsStatement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface NsDatabase {
  exec(sql: string): void;
  prepare(sql: string): NsStatement;
  close(): void;
}

/**
 * Node runtime FALLBACK adapter over the built-in `node:sqlite` (`DatabaseSync`). Selected only
 * when `better-sqlite3` cannot be resolved — notably inside the self-contained `.mcpb` bundle, which
 * ships no `node_modules`. `node:sqlite` is built into Node (the MCPB manifest requires Node >=24;
 * it has been flag-free since 22.13 / 23.4), so no native module needs to be present. The whole test
 * suite already runs on `node:sqlite` (test/helpers `openMemoryDb`), so query compatibility is
 * established. Loadable extensions (sqlite-vec) are intentionally NOT exposed here, so vector search
 * uses the in-process brute-force fallback (see the `loadExtension` note in db/types.ts).
 */
export async function openNodeSqlite(path: string, busyTimeoutMs?: number): Promise<Db> {
  const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
    DatabaseSync: new (location: string) => NsDatabase;
  };
  const db = new DatabaseSync(path);
  // Same per-connection baseline as the other adapters (THE-273), shared so the ORDER cannot drift
  // between them — busy_timeout must precede anything that can contend (THE-745). See
  // db/pragmas.ts. Applied via exec since node:sqlite has no dedicated pragma() helper.
  // busyTimeoutMs is forwarded rather than called bare (THE-935) so config's db.busyTimeoutMs
  // reaches this connection instead of silently falling back to the default.
  for (const p of connectionPragmas(busyTimeoutMs)) db.exec(`PRAGMA ${p}`);
  const make = (sql: string): Statement => {
    const st = db.prepare(sql);
    return {
      run: (...params: unknown[]): RunResult => st.run(...params),
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
    close: (): void => {
      db.close();
    },
  };
}
