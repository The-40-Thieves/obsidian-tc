// THE-73 Phase 1 — chunk-level BM25 lexical stream. Proves: (1) the query tokeniser, (2) the
// graceful no-op when chunk_fts is absent (the property that keeps graph-recall.test.ts unchanged
// under node:sqlite), and — when FTS5 is compiled into the test runtime — (3) BM25 ranking over
// chunk content and (4) graph_search recovering a lexical-only chunk (exact term, low cosine) that
// the vector seeds miss. Tests 3/4 self-skip when FTS5 is unavailable, so the suite is green either
// way.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { bm25Chunks, chunkFtsMatch, ensureChunkFts } from "../src/search/chunk_fts";
import { graphSearch } from "../src/search/graph_search";
import { floatBlob } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "v1";

// Unit vector with cosine `c` to the query vec [1,0,0,0].
function vd(c: number): number[] {
  return [c, Math.sqrt(1 - c * c), 0, 0];
}

function seedDb(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  db.exec(
    `CREATE TABLE vault_edges (
       source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
       edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT, vault_id TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
     );`,
  );
  return db;
}

function addChunk(db: Database, id: string, path: string, content: string, vec: number[]): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, VAULT, path, "0", "[]", content, `h-${id}`, 1, 0, 0);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, 0)",
  ).run(id, "test:embed", vec.length, floatBlob(vec));
}

describe("chunk_fts / BM25 lexical stream (THE-73 Phase 1)", () => {
  it("chunkFtsMatch tokenises + OR-joins; punctuation-only -> null", () => {
    expect(chunkFtsMatch("Hello, World!")).toBe('"hello" OR "world"');
    expect(chunkFtsMatch("   ...  ")).toBeNull();
  });

  it("bm25Chunks returns [] when chunk_fts is absent (graceful no-op)", () => {
    const db = seedDb();
    addChunk(db, "c1", "A.md", "alpha beta", vd(0.9));
    expect(bm25Chunks(db, VAULT, "alpha", 10)).toEqual([]);
  });

  it("ranks chunks by BM25 when FTS5 is available", () => {
    const db = seedDb();
    addChunk(db, "c1", "A.md", "the quick brown fox", vd(0.9));
    addChunk(db, "c2", "B.md", "lazy dog sleeps", vd(0.8));
    if (!ensureChunkFts(db)) return; // FTS5 not compiled into this runtime — no-op path covered above
    const hits = bm25Chunks(db, VAULT, "quick fox", 10);
    expect(hits.map((h) => h.chunk_id)).toContain("c1");
    expect(hits.map((h) => h.chunk_id)).not.toContain("c2");
  });

  it("graph_search surfaces a lexical-only chunk the vector seeds miss", async () => {
    const db = seedDb();
    addChunk(db, "seed", "S.md", "unrelated seed text", vd(0.99));
    for (const [i, id] of ["n0", "n1", "n2"].entries()) {
      addChunk(db, id, `${id}.md`, "filler noise", vd(0.9 - i * 0.1));
    }
    // Near-zero cosine (won't seed) but contains the query terms — recoverable only lexically.
    addChunk(db, "lex", "L.md", "obsidian retrieval keyword", vd(0.0));
    if (!ensureChunkFts(db)) return;
    const results = await graphSearch(db, {
      query: "obsidian keyword",
      queryVec: [1, 0, 0, 0],
      vaultId: VAULT,
      seedCount: 2, // seeds = {seed, n0}; lex is outside the vector top-k
      finalTopK: 10,
      router: { enabled: false },
    });
    const ids = results.map((r) => r.chunk_id);
    expect(ids).toContain("lex");
    expect(results.find((r) => r.chunk_id === "lex")?.source).toBe("lexical");
  });
});
