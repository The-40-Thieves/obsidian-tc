// WP3 (docs/plans/2026-07-30-codebase-refactor-map.md): the invariant the map calls for and the
// indexer never had a test proving — a failure PARTWAY THROUGH a note's persistence must leave no
// partial state. indexNote writes a note's chunks, chunk_embeddings, chunk_fts and notes rows, then
// bumps vault_generation, ALL inside one inWriteTransaction (indexer.ts). If the LAST statement in
// that transaction (the vault_generation bump) throws, everything written earlier in the same
// transaction must be rolled back too — that is exactly what BEGIN IMMEDIATE / ROLLBACK (db/txn.ts)
// exists to guarantee, and this is the first test that actually drives a failure late enough to
// prove it rather than assuming it.
//
// Uses a REAL file-backed SQLite connection (openNodeSqlite), not the in-memory test helper: an
// in-memory db can't distinguish "rolled back" from "never happened", and a same-connection read
// sees uncommitted writes either way. The distinguishing behaviour this test needs — writes made
// under BEGIN IMMEDIATE actually reverting on ROLLBACK versus surviving because they were committed
// early — only exists against a real connection/transaction.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeSqlite } from "../src/db/node-node-sqlite";
import { provisionCacheDb } from "../src/db/provision";
import type { Database, Statement } from "../src/db/types";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { indexNote } from "../src/search/indexer";

const VAULT_ID = "test";
const PATH = "note.md";
// Two headings -> chunkNote (src/search/chunk.ts) yields two chunks, so applyNoteWrites issues
// multiple INSERT INTO chunks calls before the transaction's final statement (the vault_generation
// bump) runs — the writes that must NOT survive a late failure.
const RAW =
  "# Alpha\n\nThe quick brown fox jumps over the lazy dog.\n\n# Beta\n\nA second section.\n";

/** Wrap a real Database so any prepared statement whose SQL contains `matchSql` throws on `.run()`
 *  — a failure injected at a specific point in an otherwise-real transaction. Every other statement
 *  (including reads used by table-existence probes) passes through unchanged. */
function injectRunFailure(real: Database, matchSql: string): Database {
  const wrap = (sql: string, stmt: Statement): Statement =>
    sql.includes(matchSql)
      ? {
          run: (): never => {
            throw new Error(`injected failure at: ${matchSql}`);
          },
          get: (...args: unknown[]) => stmt.get(...args),
          all: (...args: unknown[]) => stmt.all(...args),
        }
      : stmt;
  return {
    exec: (sql: string) => real.exec(sql),
    prepare: (sql: string) => wrap(sql, real.prepare(sql)),
    prepareCached: real.prepareCached
      ? (sql: string) => wrap(sql, (real.prepareCached as (s: string) => Statement)(sql))
      : undefined,
    loadExtension: real.loadExtension?.bind(real),
    close: real.close?.bind(real),
  };
}

describe("indexNote transaction rollback (WP3 invariant)", () => {
  let dir: string;
  let real: Database;

  afterEach(() => {
    real.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a failure on the LAST statement of the transaction leaves no partial state", async () => {
    dir = mkdtempSync(join(tmpdir(), "otc-idx-rollback-"));
    real = await openNodeSqlite(join(dir, "cache.db"));
    provisionCacheDb(real);

    // Fail on the vault_generation bump (generation.ts bumpGeneration) — the LAST write inside
    // indexNote's transaction, so chunk/embedding/FTS/note writes have all already run on this
    // connection by the time it throws.
    const db = injectRunFailure(real, "INSERT INTO vault_generation");
    const provider = fakeEmbeddingProvider({ dimensions: 8 });

    await expect(indexNote(db, provider, VAULT_ID, PATH, RAW, false, () => 1000)).rejects.toThrow(
      /injected failure/,
    );

    // Query the REAL (unwrapped) connection — the transaction must have rolled back, so none of
    // this note's writes survive.
    const chunks = real
      .prepare("SELECT count(*) AS c FROM chunks WHERE vault_id = ? AND path = ?")
      .get(VAULT_ID, PATH) as { c: number };
    expect(chunks.c).toBe(0);

    const embeddings = real
      .prepare(
        "SELECT count(*) AS c FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE c.vault_id = ? AND c.path = ?",
      )
      .get(VAULT_ID, PATH) as { c: number };
    expect(embeddings.c).toBe(0);

    const notes = real
      .prepare("SELECT count(*) AS c FROM notes WHERE vault_id = ? AND path = ?")
      .get(VAULT_ID, PATH) as { c: number };
    expect(notes.c).toBe(0);

    const ftsTableExists = real
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'chunk_fts'")
      .get() as { x: number } | undefined;
    if (ftsTableExists) {
      const fts = real.prepare("SELECT count(*) AS c FROM chunk_fts WHERE path = ?").get(PATH) as {
        c: number;
      };
      expect(fts.c).toBe(0);
    }

    const generationTableExists = real
      .prepare(
        "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'vault_generation'",
      )
      .get() as { x: number } | undefined;
    if (generationTableExists) {
      const generation = real
        .prepare("SELECT generation FROM vault_generation WHERE vault_id = ?")
        .get(VAULT_ID) as { generation: number } | undefined;
      expect(generation).toBeUndefined();
    }
  });

  it("control: the same note indexes cleanly with no injected failure", async () => {
    dir = mkdtempSync(join(tmpdir(), "otc-idx-rollback-ok-"));
    real = await openNodeSqlite(join(dir, "cache.db"));
    provisionCacheDb(real);
    const provider = fakeEmbeddingProvider({ dimensions: 8 });

    const result = await indexNote(real, provider, VAULT_ID, PATH, RAW, false, () => 1000);
    expect(result.upserted).toBe(2);

    const chunks = real
      .prepare("SELECT count(*) AS c FROM chunks WHERE vault_id = ? AND path = ?")
      .get(VAULT_ID, PATH) as { c: number };
    expect(chunks.c).toBe(2);
  });
});
