// THE-711 follow-up — chunk_fts is CONTENTLESS, and these are the assertions that make that real.
//
// The existing chunk-fts.test.ts does not cover any of this: reverting the CREATE statement to the
// old 4-column content-storing shape leaves all four of its tests green, because they only exercise
// matching and ranking, which work identically either way. Measured before writing this file.
//
// So each test here is paired with the mutation it catches:
//
//   shape          -> revert the CREATE statement            (the 14.5 MB the change exists for)
//   rowid identity -> let SQLite assign FTS rowids           (matches right, joins to wrong chunks)
//   delete order   -> delete the chunk before the FTS row    (orphan -> permanent full reindex)
//   migration      -> skip migrateChunkFtsShape              (upgraded installs keep the old table)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { bm25Chunks, deleteChunkFtsRow, ensureChunkFts } from "../src/search/chunk_fts";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "v1";

function seedDb(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  return db;
}

function addChunk(db: Database, id: string, path: string, content: string): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, '0', '[]', ?, ?, 1, 0, 0)",
  ).run(id, VAULT, path, content, `h-${id}`);
}

/** FTS5 compiled in? Every test here needs it; skip cleanly rather than fail on node:sqlite. */
function ftsAvailable(db: Database): boolean {
  try {
    db.exec("CREATE VIRTUAL TABLE __probe USING fts5(x)");
    db.exec("DROP TABLE __probe");
    return true;
  } catch {
    return false;
  }
}

describe("THE-711 — chunk_fts is contentless", () => {
  it("stores NO copy of the indexed text", () => {
    const db = seedDb();
    if (!ftsAvailable(db)) return;
    addChunk(db, "c1", "a.md", "alpha beta gamma");
    expect(ensureChunkFts(db)).toBe(true);

    // The DDL says contentless...
    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunk_fts'")
      .get() as { sql: string };
    expect(ddl.sql).toContain("contentless_delete");

    // ...and the shadow table that held the duplicate text is GONE. This is the assertion that
    // fails if the CREATE statement is reverted, and it is the whole point of the change: a
    // content-storing FTS5 table has a `chunk_fts_content` shadow, a contentless one does not.
    const shadows = db
      .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'chunk_fts_%'")
      .all() as Array<{ name: string }>;
    expect(shadows.map((s) => s.name)).not.toContain("chunk_fts_content");
  });

  it("aligns its rowid with chunks.rowid, so the join returns the RIGHT chunk", () => {
    const db = seedDb();
    if (!ftsAvailable(db)) return;
    // A ROWID GAP is what makes this test able to fail. Written the obvious way — three chunks at
    // rowids 1,2,3 — auto-assigned FTS rowids would also be 1,2,3 and the identity would hold by
    // coincidence; mutating the backfill to drop `rowid` left the whole file green. Measured.
    //
    // So: create three, delete the first, and only THEN build the index. chunks now occupies
    // rowids 2 and 3, while auto-assignment would produce 1 and 2 — every join off by one.
    addChunk(db, "c1", "a.md", "alpha");
    addChunk(db, "c2", "b.md", "beta");
    addChunk(db, "c3", "c.md", "gamma unique");
    db.prepare("DELETE FROM chunks WHERE id = 'c1'").run();
    expect(ensureChunkFts(db)).toBe(true);

    const first = db.prepare("SELECT MIN(rowid) AS m FROM chunks").get() as { m: number };
    expect(first.m).toBeGreaterThan(1); // the gap really exists, or this test proves nothing

    const hits = bm25Chunks(db, VAULT, "unique", 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.chunk_id).toBe("c3");
    expect(hits[0]?.path).toBe("c.md");
    expect(hits[0]?.content).toBe("gamma unique");
  });

  it("scopes by vault through the chunks join, not through a contentless column", () => {
    const db = seedDb();
    if (!ftsAvailable(db)) return;
    addChunk(db, "c1", "a.md", "shared term");
    db.prepare(
      "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES ('c2', 'v2', 'z.md', '0', '[]', 'shared term', 'h2', 1, 0, 0)",
    ).run();
    expect(ensureChunkFts(db)).toBe(true);

    // A contentless table returns NOTHING for its declared columns, so a `WHERE
    // chunk_fts.vault_id = ?` predicate would silently match zero rows and this would be [].
    // Getting exactly the v1 row proves the filter really moved onto chunks.
    const hits = bm25Chunks(db, VAULT, "shared", 5);
    expect(hits.map((h) => h.chunk_id)).toEqual(["c1"]);
  });

  it("LOAD-BEARING: deleting by rowid leaves no orphan, so counts stay reconciled", () => {
    const db = seedDb();
    if (!ftsAvailable(db)) return;
    addChunk(db, "c1", "a.md", "alpha");
    addChunk(db, "c2", "b.md", "beta");
    expect(ensureChunkFts(db)).toBe(true);

    const { rowid } = db.prepare("SELECT rowid FROM chunks WHERE id = 'c1'").get() as {
      rowid: number;
    };
    // The ORDER this change exists to enforce: FTS row first, THEN the chunk. Reversed, the rowid
    // is unresolvable and the entry is stranded forever.
    deleteChunkFtsRow(db, rowid);
    db.prepare("DELETE FROM chunks WHERE id = 'c1'").run();

    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    // Equal counts are what keeps ensureChunkFts from triggering a full reindex on every open.
    expect(n("SELECT COUNT(*) AS n FROM chunk_fts")).toBe(n("SELECT COUNT(*) AS n FROM chunks"));
    expect(bm25Chunks(db, VAULT, "alpha", 5)).toEqual([]);
    expect(bm25Chunks(db, VAULT, "beta", 5)).toHaveLength(1);
  });

  it("migrates a pre-existing content-storing table instead of leaving it in place", () => {
    const db = seedDb();
    if (!ftsAvailable(db)) return;
    // Exactly the shape that shipped before this change.
    db.exec(
      "CREATE VIRTUAL TABLE chunk_fts USING fts5(chunk_id UNINDEXED, vault_id UNINDEXED, path UNINDEXED, content, tokenize='porter unicode61')",
    );
    db.prepare(
      "INSERT INTO chunk_fts (chunk_id, vault_id, path, content) VALUES ('c1', ?, 'a.md', 'legacy alpha')",
    ).run(VAULT);
    addChunk(db, "c1", "a.md", "legacy alpha");

    // `CREATE VIRTUAL TABLE IF NOT EXISTS` alone is a NO-OP against this, which is why the shape
    // migration has to be explicit — without it an upgraded install keeps the old table and every
    // rowid-shaped write below fails against it.
    expect(ensureChunkFts(db)).toBe(true);

    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunk_fts'")
      .get() as { sql: string };
    expect(ddl.sql).toContain("contentless_delete");
    // And the index was rebuilt from chunks rather than left empty.
    expect(bm25Chunks(db, VAULT, "legacy", 5).map((h) => h.chunk_id)).toEqual(["c1"]);
  });
});
