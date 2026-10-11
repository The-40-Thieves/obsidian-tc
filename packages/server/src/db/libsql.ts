import { existsSync } from "node:fs";
import { applyConnectionPragmasOrClose } from "./apply-pragmas";
import { readonlyConnectionPragmas } from "./pragmas";
import type {
  Database as Db,
  LibsqlSyncOptions,
  OpenOptions,
  ReplicaSyncResult,
  RunResult,
  Statement,
} from "./types";

// The slice of the `libsql` package (a better-sqlite3-shaped API over the libSQL C fork) used
// here. Typed locally: the package's own typings predate `authToken` / `syncPeriod`.
interface LsStatement {
  run(...params: unknown[]): RunResult & { duration?: number };
  get(...params: unknown[]): (Record<string, unknown> & { _metadata?: unknown }) | undefined;
  all(...params: unknown[]): unknown[];
}
interface LsDatabase {
  exec(sql: string): void;
  prepare(sql: string): LsStatement;
  pragma(source: string): unknown;
  loadExtension(path: string): void;
  close(): void;
  readonly inTransaction: boolean;
  sync(): { frames_synced?: number; frame_no?: number } | undefined;
}
type LsConstructor = new (path: string, opts?: Record<string, unknown>) => LsDatabase;

/**
 * Statements that may run on the LOCAL file handle of a replica. Anything else, and every
 * statement inside an open transaction, goes to the write handle (and so to the primary).
 *
 * Why the split exists: measured on libsql 0.5.29 + sqld 0.24.32, the handle opened with `syncUrl`
 * forwards writes correctly but serves STALE reads from its own page cache (a row it just updated,
 * or one updated by another machine, reads back old until the process reopens the file) and
 * rejects `loadExtension` and most connection pragmas. A second, plain handle on the same replica
 * file sees both its own forwarded writes and other machines' writes (after `sync()`) at once, and
 * can `loadExtension` sqlite-vec. So: writes and transactions through the replica handle, reads
 * through the plain handle.
 */
export function isLocalRead(sql: string): boolean {
  const s = sql.trimStart();
  if (/^(select|explain)\b/i.test(s)) return true;
  if (/^with\b/i.test(s)) return !/\b(insert|update|delete|replace)\b/i.test(s);
  return /^pragma\b/i.test(s) && !s.includes("=");
}

const TXN_END = /^\s*(commit|end|rollback)\b/i;

/**
 * Open a Database over libSQL (`libsql` npm package).
 *
 * Without `opts.sync` this is a plain local connection: the same file format and WAL semantics as
 * the other adapters, on SQLite 3.45 (the other adapters run 3.5x). With `opts.sync` it is an
 * embedded replica: the file is a read replica of a libSQL server (Turso Cloud or self-hosted
 * sqld), and writes are forwarded to that server. `opts.readonly` with `opts.sync` opens only the
 * local read handle, for a follower process that must not talk to the server or run a second
 * replicator on the same file.
 *
 * `libsql` is imported dynamically and is an optional dependency, like better-sqlite3: a build
 * that never selects this adapter never evaluates the native module.
 */
export async function openLibsql(
  path: string,
  busyTimeoutMs?: number,
  opts: OpenOptions = {},
): Promise<Db> {
  const { default: Libsql } = (await import("libsql")) as unknown as { default: LsConstructor };
  const sync = opts.sync;
  const replicating = sync !== undefined && !opts.readonly;
  // The write handle first: opening it creates the replica file and performs the initial sync.
  const writer = replicating ? openWriter(Libsql, path, sync) : undefined;
  let reader: LsDatabase;
  let readonlyMode: "native" | "fallback" | undefined;
  if (opts.readonly) {
    // libsql 0.5.29 accepts `{ readonly: true }` and then WRITES anyway (measured: an INSERT through
    // such a handle succeeded), so it is not used. Refuse to create a missing file, and make the
    // handle `query_only`; the OS-level guarantee of the "native" mode is not available.
    if (!existsSync(path)) {
      throw Object.assign(new Error("unable to open database file"), {
        code: "SQLITE_CANTOPEN",
        errno: 14,
      });
    }
    reader = new Libsql(path);
    try {
      for (const p of [...readonlyConnectionPragmas(busyTimeoutMs), "query_only = 1"]) {
        reader.pragma(p);
      }
      reader.prepare("PRAGMA schema_version").get();
    } catch (e) {
      reader.close();
      throw e;
    }
    readonlyMode = "fallback";
  } else {
    reader = new Libsql(path);
    try {
      applyConnectionPragmasOrClose(reader, (p) => reader.pragma(p), busyTimeoutMs);
      // The reader of a replica must never write into the replicated file.
      if (writer) reader.pragma("query_only = 1");
    } catch (e) {
      writer?.close();
      throw e;
    }
  }

  const inWriterTxn = (): boolean => writer?.inTransaction === true;
  const make = (sql: string): Statement => {
    const local = isLocalRead(sql);
    let r: LsStatement | undefined;
    let w: LsStatement | undefined;
    const pick = (): LsStatement => {
      if (!writer || (local && !inWriterTxn())) {
        r ??= reader.prepare(sql);
        return r;
      }
      w ??= writer.prepare(sql);
      return w;
    };
    return {
      run: (...params: unknown[]): RunResult => {
        const { changes, lastInsertRowid } = pick().run(...params);
        return { changes, lastInsertRowid };
      },
      get: (...params: unknown[]): unknown => {
        const row = pick().get(...params);
        // libsql attaches an enumerable `_metadata` timing object to every `get()` row.
        if (row && "_metadata" in row) delete row._metadata;
        return row ?? undefined;
      },
      all: (...params: unknown[]): unknown[] => pick().all(...params),
    };
  };
  const cache = new Map<string, Statement>();
  const db: Db = {
    exec: (sql: string): void => {
      if (writer && !(isLocalRead(sql) && !inWriterTxn() && !TXN_END.test(sql))) writer.exec(sql);
      else reader.exec(sql);
    },
    prepare: make,
    prepareCached: (sql: string): Statement => {
      const hit = cache.get(sql);
      if (hit) return hit;
      const st = make(sql);
      cache.set(sql, st);
      return st;
    },
    // The write handle cannot load extensions; the reader can, and it is the one that runs vec0
    // queries. The SERVER must have vec0 too for writes to a vec0 table (sqld --extensions-path).
    loadExtension: (extPath: string): void => {
      reader.loadExtension(extPath);
    },
    close: (): void => {
      reader.close();
      writer?.close();
    },
    inTransaction: (): boolean => (writer ?? reader).inTransaction,
    ...(readonlyMode !== undefined ? { readonlyMode } : {}),
  };
  if (writer) {
    db.sync = (): ReplicaSyncResult => {
      const r = writer.sync();
      return { framesSynced: r?.frames_synced ?? 0, frameNo: r?.frame_no };
    };
  }
  return db;
}

function openWriter(Libsql: LsConstructor, path: string, sync: LibsqlSyncOptions): LsDatabase {
  const w = new Libsql(path, {
    syncUrl: sync.url,
    ...(sync.authToken ? { authToken: sync.authToken } : {}),
    ...(sync.syncIntervalMs ? { syncPeriod: sync.syncIntervalMs / 1000 } : {}),
  });
  try {
    // The only connection pragma the replica handle accepts (measured); the rest of the baseline
    // (busy_timeout, journal_mode, cache_size, mmap_size, ...) belongs to the local read handle.
    w.pragma("foreign_keys = ON");
  } catch (e) {
    w.close();
    throw e;
  }
  return w;
}
