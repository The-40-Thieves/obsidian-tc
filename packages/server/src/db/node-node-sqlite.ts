import { applyConnectionPragmasOrClose } from "./apply-pragmas";
import { openReadonlyWithFallback, readonlyConnectionPragmas } from "./pragmas";
import type { Database as Db, OpenOptions, RunResult, Statement } from "./types";

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
  // GH #995 fix round (LOCK_TXN_LOSS): node:sqlite's own name for what bun:sqlite/better-sqlite3
  // call `.inTransaction` — see db/types.ts's Database.inTransaction doc comment.
  readonly isTransaction: boolean;
  loadExtension(path: string): void;
  enableLoadExtension(allow: boolean): void;
}
interface NsDatabaseOptions {
  readOnly?: boolean;
  allowExtension?: boolean;
}

/**
 * Node runtime FALLBACK adapter over the built-in `node:sqlite` (`DatabaseSync`). Selected only
 * when `better-sqlite3` cannot be resolved — notably inside the self-contained `.mcpb` bundle, which
 * ships no `node_modules`. `node:sqlite` is built into Node (the MCPB manifest requires Node >=24;
 * it has been flag-free since 22.13 / 23.4), so no native module needs to be present. The whole test
 * suite already runs on `node:sqlite` (test/helpers `openMemoryDb`), so query compatibility is
 * established. sqlite-vec loads through `loadExtension` below, so the packed .mcpb (which ships
 * sqlite-vec but no better-sqlite3) gets the same dense index as an npm install.
 */
export async function openNodeSqlite(
  path: string,
  busyTimeoutMs?: number,
  opts: OpenOptions = {},
): Promise<Db> {
  const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
    DatabaseSync: new (location: string, options?: NsDatabaseOptions) => NsDatabase;
  };
  // THE-1039 fix round 2 (C1) reverted `readOnly: true` (fix round 1's F2; see bun-sqlite.ts's
  // matching comment for the full macOS incident) to open NORMALLY unconditionally, applied here
  // for consistency with the other two adapters rather than because node:sqlite was shown to share
  // the failure.
  //
  // Fix round 3 (C2) — that unconditional normal open was ITSELF found unsafe: a writable file
  // descriptor cannot stop SQLite performing its own checkpoint-on-close if this connection closes
  // a DANGLING, un-checkpointed WAL — a PHYSICAL mutation of the main file regardless of which
  // pragmas this code issues.
  //
  // READONLY-FIRST WITH FALLBACK: try `{ readOnly: true }` first and fall back to a normal open
  // ONLY when that throws. `readonlyMode` records which path was taken. node:sqlite exposes no
  // "writable fd, refuse to create" option distinct from `readOnly`, so the fallback opens
  // NORMALLY — every caller of `openDatabase(..., { readonly: true })` already checks `existsSync`
  // first, so an accidental create-on-missing is not reachable in practice. What the fallback
  // cannot do is prevent SQLite's checkpoint-on-close — see pragmas.ts's
  // `readonlyConnectionPragmas` and types.ts's `OpenOptions` for the narrowed guarantee this
  // implies.
  // `allowExtension` is what permits `loadExtension` at all, and it also turns on SQL-callable
  // `load_extension()`, which better-sqlite3 and bun:sqlite never expose. So it is switched back
  // off at once and re-enabled only around the one trusted call in `loadExtension` below.
  const openDb = (o: NsDatabaseOptions = {}): NsDatabase => {
    const d = new DatabaseSync(path, { ...o, allowExtension: true });
    d.enableLoadExtension(false);
    return d;
  };
  let db: NsDatabase;
  let readonlyMode: "native" | "fallback" | undefined;
  // Same per-connection baseline as the other adapters (THE-273), shared so the ORDER cannot drift —
  // busy_timeout must precede anything that can contend (THE-745). See db/pragmas.ts; applied via
  // exec since node:sqlite has no pragma() helper, busyTimeoutMs forwarded not bare (THE-935). The readonly subset runs INSIDE the open attempt
  // — see `openReadonlyWithFallback`. This adapter is also the one where an unguarded fallback was a
  // FILE-CREATING bug: with no "writable, must exist" option its fallback is a plain open.
  if (opts.readonly) {
    const open = openReadonlyWithFallback(
      path,
      () => openDb({ readOnly: true }),
      () => openDb(),
      {
        configure: (d) => {
          for (const p of readonlyConnectionPragmas(busyTimeoutMs)) d.exec(`PRAGMA ${p}`);
        },
        probe: (d) => {
          d.prepare("PRAGMA schema_version").get();
        },
        close: (d) => {
          d.close();
        },
      },
    );
    db = open.db;
    readonlyMode = open.readonlyMode;
  } else {
    db = openDb();
    applyConnectionPragmasOrClose(db, (p) => db.exec(`PRAGMA ${p}`), busyTimeoutMs);
  }
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
    loadExtension: (extPath: string): void => {
      db.enableLoadExtension(true);
      try {
        db.loadExtension(extPath);
      } finally {
        db.enableLoadExtension(false);
      }
    },
    // GH #995 fix round (LOCK_TXN_LOSS) — see db/types.ts's Database.inTransaction doc comment.
    inTransaction: (): boolean => db.isTransaction,
    ...(readonlyMode !== undefined ? { readonlyMode } : {}),
  };
}
