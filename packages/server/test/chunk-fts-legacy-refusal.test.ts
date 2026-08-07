// THE-750 — the lexical stream REFUSES a pre-THE-711 chunk_fts instead of mis-joining it.
//
// THE-711 made chunk_fts contentless and keyed its rowids to `chunks.rowid`. `bm25Chunks` joins on
// that identity. Against the old 4-column content-storing table the rowids are independent, so the
// join does not fail — it pairs FTS hits to the WRONG chunks. Measured on a real pre-THE-711 cache:
// 8,933 of 13,451 rows "joined" (all mis-paired) and 4,897 dropped. That cost the fused arm ~0.13
// nDCG@10 while the pure-dense arm reproduced byte-identically, which is what made it read as a
// retrieval finding rather than a bug.
//
// `ensureChunkFts` repairs the shape, but it is reachable only from the write path, so a read-only
// consumer (the eval harness, `doctor --probe`, an archived cache) can never trigger it.
//
// Each test is paired with the mutation it catches:
//
//   refuses legacy shape  -> delete the assertContentlessChunkFts call    (silent mis-join returns)
//   raised past the catch -> move the call inside bm25Chunks' try         (swallowed into `[]`)
//   contentless is quiet  -> make the guard throw unconditionally         (every install breaks)
//   absent table is quiet -> treat a missing chunk_fts as an error        (lazy provisioning breaks)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { bm25Chunks, ensureChunkFts } from "../src/search/chunk_fts";
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

function ftsAvailable(db: Database): boolean {
  try {
    db.exec("CREATE VIRTUAL TABLE __probe USING fts5(x)");
    db.exec("DROP TABLE __probe");
    return true;
  } catch {
    return false;
  }
}

/** Build the exact pre-THE-711 table, populated so the failure is a MIS-JOIN and not an empty
 *  index — an empty one would return `[]` for the boring reason and prove nothing. */
function seedLegacyChunkFts(db: Database): void {
  db.exec(
    "CREATE VIRTUAL TABLE chunk_fts USING fts5(chunk_id UNINDEXED, vault_id UNINDEXED, path UNINDEXED, content, tokenize='porter unicode61')",
  );
  const ins = db.prepare(
    "INSERT INTO chunk_fts (chunk_id, vault_id, path, content) VALUES (?, ?, ?, ?)",
  );
  for (const r of db.prepare("SELECT id, path, content FROM chunks").all() as {
    id: string;
    path: string;
    content: string;
  }[]) {
    ins.run(r.id, VAULT, r.path, r.content);
  }
}

describe("THE-750 — refuse a pre-THE-711 chunk_fts rather than mis-join it", () => {
  it("THROWS on the legacy shape instead of returning mis-joined rows", () => {
    const db = seedDb();
    if (!ftsAvailable(db)) return;
    addChunk(db, "c1", "a.md", "alpha beta gamma");
    addChunk(db, "c2", "b.md", "delta epsilon zeta");
    seedLegacyChunkFts(db);

    // Floor: the legacy index really does MATCH, so a refusal cannot be confused with "no hits".
    const raw = db
      .prepare("SELECT count(*) AS n FROM chunk_fts WHERE chunk_fts MATCH 'alpha'")
      .get() as { n: number };
    expect(raw.n).toBe(1);

    expect(() => bm25Chunks(db, VAULT, "alpha", 5)).toThrow(/pre-THE-711|contentless_delete/);
  });

  it("raises PAST bm25Chunks' catch — the refusal is not swallowed into []", () => {
    const db = seedDb();
    if (!ftsAvailable(db)) return;
    addChunk(db, "c1", "a.md", "alpha beta gamma");
    seedLegacyChunkFts(db);

    // The distinction this asserts: `[]` is what the surrounding try/catch produces for every other
    // failure, and `[]` is also a legitimate answer. Only a throw is unambiguous.
    let threw = false;
    try {
      const hits = bm25Chunks(db, VAULT, "alpha", 5);
      expect(hits).toBeUndefined(); // unreachable; fails loudly if the guard is swallowed
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("stays SILENT on the contentless shape — the guard must not fire on a healthy install", () => {
    const db = seedDb();
    if (!ftsAvailable(db)) return;
    addChunk(db, "c1", "a.md", "alpha beta gamma");
    expect(ensureChunkFts(db)).toBe(true);

    const hits = bm25Chunks(db, VAULT, "alpha", 5);
    expect(hits.map((h) => h.chunk_id)).toEqual(["c1"]);
  });

  it("stays SILENT when chunk_fts is absent — provisioning is lazy by design", () => {
    const db = seedDb();
    addChunk(db, "c1", "a.md", "alpha beta gamma");
    // No ensureChunkFts, no table. Callers gate on the boolean; this must not become an error.
    expect(() => bm25Chunks(db, VAULT, "alpha", 5)).not.toThrow();
    expect(bm25Chunks(db, VAULT, "alpha", 5)).toEqual([]);
  });

  it("re-answers after a repair — the positive verdict is cached, the negative is not", () => {
    const db = seedDb();
    if (!ftsAvailable(db)) return;
    addChunk(db, "c1", "a.md", "alpha beta gamma");
    seedLegacyChunkFts(db);
    expect(() => bm25Chunks(db, VAULT, "alpha", 5)).toThrow();

    // ensureChunkFts drops the legacy table and rebuilds contentless, on the SAME handle.
    expect(ensureChunkFts(db)).toBe(true);
    expect(bm25Chunks(db, VAULT, "alpha", 5).map((h) => h.chunk_id)).toEqual(["c1"]);
  });
});
