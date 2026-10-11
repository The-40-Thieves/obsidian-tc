// libSQL adapter (db/libsql.ts), local mode: no server, no network. The sqld-backed replica
// behaviour is in libsql-sync.test.ts; this file proves the adapter is a faithful Database
// (contract), runs the real migration chain and both FTS5 tables, serves sqlite-vec KNN through
// the production indexer, and pins the statement routing the replica mode depends on.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isLocalRead, openLibsql } from "../src/db/libsql";
import { CACHE_MIGRATIONS, provisionCacheDb } from "../src/db/provision";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { bm25Chunks } from "../src/search/chunk_fts";
import { ftsCandidates } from "../src/search/fts";
import { indexVault } from "../src/search/indexer";
import { buildRepresentationManifest } from "../src/search/representation";
import { semanticSearch } from "../src/search/semantic";
import { loadVec } from "../src/search/vec";
import { makeTempDir, rmTemp } from "./tmp";

let libsqlOk = true;
try {
  const d = await openLibsql(":memory:");
  d.close?.();
} catch {
  libsqlOk = false;
}

describe.skipIf(!libsqlOk)("libsql adapter (local mode)", () => {
  const dir = makeTempDir("otc-libsql-");
  afterAll(() => rmTemp(dir));

  it("implements the Database contract with better-sqlite3-shaped results", async () => {
    const db = await openLibsql(join(dir, "t.db"));
    db.exec("CREATE TABLE t(id TEXT PRIMARY KEY, n INTEGER)");
    const ins = db.prepare("INSERT INTO t(id, n) VALUES (?, ?)");
    // Exactly the port's RunResult: libsql adds a `duration` field that must not leak.
    expect(ins.run("a", 1)).toEqual({ changes: 1, lastInsertRowid: 1 });
    // libsql adds an enumerable `_metadata` timing object to get() rows; toEqual would see it.
    expect(db.prepare("SELECT n FROM t WHERE id = ?").get("a")).toEqual({ n: 1 });
    expect(db.prepare("SELECT n FROM t WHERE id = ?").get("missing")).toBeUndefined();
    expect(db.prepare("SELECT * FROM t").all()).toEqual([{ id: "a", n: 1 }]);
    expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe(
      "wal",
    );
    expect(db.prepareCached?.("SELECT 1 AS x")).toBe(db.prepareCached?.("SELECT 1 AS x"));
    expect(db.inTransaction?.()).toBe(false);
    db.exec("BEGIN EXCLUSIVE");
    expect(db.inTransaction?.()).toBe(true);
    db.exec("ROLLBACK");
    expect(db.sync).toBeUndefined(); // no replica without opts.sync
    db.close?.();
  });

  it("reports SQLite 3.45 (the floor this engine sets, vs 3.5x on the other adapters)", async () => {
    const db = await openLibsql(":memory:");
    const v = (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
    expect(v).toMatch(/^3\.45\./);
    db.close?.();
  });

  it("applies the busy_timeout baseline first and threads busyTimeoutMs", async () => {
    const db = await openLibsql(join(dir, "busy.db"), 1234);
    expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 1234 });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    db.close?.();
  });

  it("runs the full embedded migration chain, FTS5 and sqlite-vec through the production indexer", async () => {
    const db = await openLibsql(join(dir, "cache.db"));
    const applied = provisionCacheDb(db);
    expect(applied).toHaveLength(CACHE_MIGRATIONS.length);
    expect(applied.length).toBeGreaterThan(30); // floor: an empty chain would also "match"
    expect(provisionCacheDb(db)).toEqual([]); // idempotent: checksums recorded, nothing re-applied

    const root = join(dir, "vault");
    mkdirSync(root);
    writeFileSync(join(root, "fox.md"), "# Fox\n\nthe quick brown fox jumps over the lazy dog");
    writeFileSync(join(root, "weather.md"), "# Weather\n\nheavy rain and thunderstorms tonight");
    writeFileSync(join(root, "dog.md"), "# Dog\n\nthe lazy dog sleeps under the warm sun");
    const provider = fakeEmbeddingProvider({ dimensions: 32 });
    const stats = await indexVault({
      db,
      provider,
      representation: buildRepresentationManifest(provider, {}),
      vaultId: "v",
      root,
      isReadable: () => true,
    });
    expect(stats.vec_enabled).toBe(true);
    expect(stats.chunks_upserted).toBe(3);

    // notes_fts (trigram, stores note text) and chunk_fts (contentless, porter) both exist and rank.
    const names = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE name IN ('notes_fts','chunk_fts')")
        .all() as {
        name: string;
      }[]
    )
      .map((r) => r.name)
      .sort();
    expect(names).toEqual(["chunk_fts", "notes_fts"]);
    const notes = ftsCandidates(db, "v", "thunderstorms", 5);
    expect(notes?.map((r) => r.path)).toEqual(["weather.md"]);
    expect(notes?.[0]?.rank).toBeLessThan(0); // bm25() is a negative rank, as on the other adapters
    const chunks = bm25Chunks(db, "v", "thunderstorm", 5); // porter: the note says "thunderstorms"
    expect(chunks.map((c) => c.path)).toEqual(["weather.md"]);

    // vec0: KNN ranks the on-topic notes above the unrelated one.
    const [q] = await provider.embed(["lazy dog"]);
    const hits = semanticSearch(db, "v", q ?? [], { k: 3, returnContent: true });
    expect(hits).toHaveLength(3);
    expect(["fox.md", "dog.md"]).toContain(hits[0]?.path);
    expect(hits[2]?.path).toBe("weather.md");
    expect(loadVec(db)).toBe(true);
    db.close?.();
  });

  it("opens readonly without creating a file and refuses writes (libsql's own readonly flag does not)", async () => {
    await expect(openLibsql(join(dir, "nope.db"), undefined, { readonly: true })).rejects.toThrow(
      /unable to open database file/,
    );
    const w = await openLibsql(join(dir, "ro.db"));
    w.exec("CREATE TABLE t(x)");
    w.close?.();
    const ro = await openLibsql(join(dir, "ro.db"), undefined, { readonly: true });
    expect(ro.readonlyMode).toBe("fallback");
    expect(() => ro.prepare("INSERT INTO t VALUES (1)").run()).toThrow(/readonly/i);
    ro.close?.();
  });

  it("does not make a local-only open depend on any server: opts.sync is the only switch", async () => {
    const db = await openLibsql(join(dir, "plain.db"));
    expect(db.sync).toBeUndefined();
    db.close?.();
  });
});

describe("libsql statement routing (replica mode sends writes and transactions to the primary)", () => {
  it.each([
    ["SELECT 1", true],
    ["  select * from t where a = ?", true],
    ["EXPLAIN QUERY PLAN SELECT 1", true],
    ["WITH x AS (SELECT 1) SELECT * FROM x", true],
    ["WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x", false],
    ["PRAGMA table_info(t)", true],
    ["PRAGMA user_version", true],
    ["PRAGMA user_version = 3", false],
    ["INSERT INTO t VALUES (1)", false],
    ["INSERT INTO t VALUES (1) RETURNING id", false],
    ["UPDATE t SET a = 1", false],
    ["DELETE FROM t", false],
    ["REPLACE INTO t VALUES (1)", false],
    ["CREATE VIRTUAL TABLE v USING vec0(x float[3])", false],
    ["BEGIN IMMEDIATE", false],
    ["COMMIT", false],
    ["VACUUM", false],
  ])("isLocalRead(%j) === %s", (sql, expected) => {
    expect(isLocalRead(sql)).toBe(expected);
  });
});
