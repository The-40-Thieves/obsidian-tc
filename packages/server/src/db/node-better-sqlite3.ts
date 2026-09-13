import { connectionPragmas, openReadonlyWithFallback, readonlyConnectionPragmas } from "./pragmas";
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
  // this reverted (fix round 1's F2 used the native `readonly` option, which CI's macOS leg failed
  // to open a WAL-mode fixture with, while Linux/Windows passed unchanged) — applied to every
  // adapter for consistency, not because better-sqlite3 (its own bundled SQLite, not Apple's
  // system one) was shown to have the same failure.
  //
  // Fix round 3 (C2) — round 2's unconditional `{ fileMustExist: true }` (no `readonly`) was
  // ITSELF found unsafe: a writable file descriptor cannot stop SQLite performing its own
  // checkpoint-on-close if this connection closes a DANGLING, un-checkpointed WAL — a PHYSICAL
  // mutation of the main file regardless of which pragmas this code issues.
  //
  // READONLY-FIRST WITH FALLBACK: try `{ readonly: true }` first — per better-sqlite3's own source
  // (src/objects/database.cpp): `readonly ? SQLITE_OPEN_READONLY : must_exist ?
  // SQLITE_OPEN_READWRITE : (SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE)` — and fall back to
  // `{ fileMustExist: true }` ONLY when that throws. `readonlyMode` records which path was taken.
  // The fallback still refuses to CREATE a missing file and never issues a write statement
  // (readonlyConnectionPragmas below); what it cannot do is prevent SQLite's checkpoint-on-close —
  // see pragmas.ts's `readonlyConnectionPragmas` and types.ts's `OpenOptions` for the narrowed
  // guarantee this implies.
  let db: InstanceType<typeof BetterSqlite3>;
  let readonlyMode: "native" | "fallback" | undefined;
  // Same per-connection baseline as the other adapters (THE-273), shared so the ORDER cannot drift —
  // busy_timeout must precede anything that can contend (THE-745). See db/pragmas.ts; better-sqlite3
  // takes pragma bodies bare, and busyTimeoutMs is forwarded rather than called bare (THE-935). The readonly subset is applied INSIDE the open attempt — see
  // `openReadonlyWithFallback` for why that placement is load-bearing.
  if (opts.readonly) {
    const open = openReadonlyWithFallback(
      path,
      () => new BetterSqlite3(path, { readonly: true }),
      () => new BetterSqlite3(path, { fileMustExist: true }), // never creates a missing file
      {
        configure: (d) => {
          for (const p of readonlyConnectionPragmas(busyTimeoutMs)) d.pragma(p);
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
    db = new BetterSqlite3(path);
    for (const p of connectionPragmas(busyTimeoutMs)) db.pragma(p);
  }
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
    ...(readonlyMode !== undefined ? { readonlyMode } : {}),
  };
}
