import {
  connectionPragmas,
  forceReadonlyOpenFallback,
  readonlyConnectionPragmas,
  readonlyOpenFallbackable,
} from "./pragmas";
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
}
interface NsDatabaseOptions {
  readOnly?: boolean;
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
  let db: NsDatabase;
  let readonlyMode: "native" | "fallback" | undefined;
  if (opts.readonly) {
    // Fix round 4 (H1): narrowed to one failure class — see `readonlyOpenFallbackable`. This
    // adapter is the one where the unnarrowed catch was a FILE-CREATING bug rather than merely a
    // wrong open mode: with no "writable, must exist" option, its fallback is a plain open, which
    // creates a missing database instead of reporting it.
    let opened: NsDatabase | undefined;
    if (!forceReadonlyOpenFallback()) {
      try {
        opened = new DatabaseSync(path, { readOnly: true });
        readonlyMode = "native";
      } catch (e) {
        if (!readonlyOpenFallbackable(path, e)) throw e;
      }
    }
    if (opened === undefined) {
      opened = new DatabaseSync(path);
      readonlyMode = "fallback";
    }
    db = opened;
  } else {
    db = new DatabaseSync(path);
  }
  // Same per-connection baseline as the other adapters (THE-273), shared so the ORDER cannot drift
  // between them — busy_timeout must precede anything that can contend (THE-745). See
  // db/pragmas.ts. Applied via exec since node:sqlite has no dedicated pragma() helper.
  // busyTimeoutMs is forwarded rather than called bare (THE-935) so config's db.busyTimeoutMs
  // reaches this connection instead of silently falling back to the default. readonly gets the
  // writer-pragma-free subset — see readonlyConnectionPragmas' comment.
  for (const p of opts.readonly
    ? readonlyConnectionPragmas(busyTimeoutMs)
    : connectionPragmas(busyTimeoutMs))
    db.exec(`PRAGMA ${p}`);
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
    ...(readonlyMode !== undefined ? { readonlyMode } : {}),
  };
}
