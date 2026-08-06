import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionPragmas } from "./pragmas";
import { EMBEDDED_SQLITE_BASE64 } from "./sqlite-embedded";
import type { Database as Db, RunResult, Statement } from "./types";

// THE-663 follow-up: bun:sqlite uses APPLE'S SYSTEM SQLite on macOS, and Apple builds it without
// extension support — `This build of sqlite3 does not support dynamic extension loading`, measured
// directly on macos-14 and macos-26. So loadVec()'s db.loadExtension() cannot work on darwin no
// matter how correctly vec0 is embedded, and every darwin standalone binary silently served the
// brute-force cosine scan. Bun's documented escape hatch is Database.setCustomSQLite(), pointing at
// a vanilla build, called BEFORE any Database is constructed.
//
// openBunSqlite is the only `new Database(...)` in the tree, so "before any Database" is satisfied
// by calling this at the top of it — no process-wide ordering discipline to maintain.
//
// Guarded to darwin AND to a non-empty constant: linux and windows get an extension-capable SQLite
// from bun itself, and outside a compiled darwin release binary the constant is the empty
// placeholder. Both mean "nothing to do", so `bun run`, the npm dist build and every test suite are
// untouched by this.
let customSqliteApplied = false;
function useEmbeddedSqlite(BunDatabase: { setCustomSQLite?: (p: string) => void }): void {
  if (customSqliteApplied) return;
  customSqliteApplied = true; // once per process, success or failure — a retry cannot help
  if (process.platform !== "darwin" || !EMBEDDED_SQLITE_BASE64) return;
  try {
    const dir = mkdtempSync(join(tmpdir(), "otc-sqlite-"));
    chmodSync(dir, 0o700);
    const out = join(dir, "libsqlite3.dylib");
    writeFileSync(out, Buffer.from(EMBEDDED_SQLITE_BASE64, "base64"));
    chmodSync(out, 0o755);
    BunDatabase.setCustomSQLite?.(out);
  } catch {
    // Deliberately swallowed. Failing here would turn a DEGRADED retrieval path into a server that
    // will not boot: without the custom SQLite, bun:sqlite still opens databases fine against
    // Apple's build and everything except vec0 works. loadVec() already reports its own failure,
    // and doctor's dense check (THE-688) is what surfaces it to an operator.
  }
}

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
  // Must precede the constructor below — setCustomSQLite is a no-op once a Database exists.
  useEmbeddedSqlite(BunDatabase);
  const db = new BunDatabase(path, { create: true });
  // Server-tuned per-connection baseline (THE-273), shared with the two Node adapters so the
  // ORDER cannot drift between them — busy_timeout must precede anything that can contend
  // (THE-745). See db/pragmas.ts.
  for (const p of connectionPragmas()) db.exec(`PRAGMA ${p}`);
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
