// THE-388 — bge-m3 learned-sparse stream fused into graph_search's RRF. A chunk with near-zero
// cosine (missed by the vector seeds) but strong sparse overlap with the query weights is recovered
// as source "sparse"; without querySparse the stream is a no-op.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { graphSearch } from "../src/search/graph_search";
import { ensureChunkSparse, type SparseVec, upsertChunkSparse } from "../src/search/sparse";
import { floatBlob } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "v1";

function vd(c: number): number[] {
  return [c, Math.sqrt(1 - c * c), 0, 0];
}

function db0(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  db.exec(
    `CREATE TABLE vault_edges (
       source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
       edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT, vault_id TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
     );`,
  );
  ensureChunkSparse(db);
  return db;
}

function addChunk(db: Database, id: string, path: string, vec: number[], sparse?: SparseVec): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, '0', '[]', ?, ?, 1, 0, 0)",
  ).run(id, VAULT, path, `body ${id}`, `h-${id}`);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, 0)",
  ).run(id, "test:embed", vec.length, floatBlob(vec));
  if (sparse) upsertChunkSparse(db, id, VAULT, sparse);
}

describe("sparse RRF stream in graph_search (THE-388)", () => {
  it("recovers a sparse-only chunk the vector seeds miss", async () => {
    const db = db0();
    addChunk(db, "seed", "S.md", vd(0.99));
    addChunk(db, "n0", "N0.md", vd(0.9));
    addChunk(db, "sp", "SP.md", vd(0.0), { obsidian: 0.9, retrieval: 0.5 });
    const results = await graphSearch(db, {
      query: "x",
      queryVec: [1, 0, 0, 0],
      vaultId: VAULT,
      seedCount: 2, // seeds = {seed, n0}; sp is outside the vector top-k
      finalTopK: 10,
      router: { enabled: false },
      lexical: { enabled: false },
      querySparse: { obsidian: 1.0 },
    });
    const ids = results.map((r) => r.chunk_id);
    expect(ids).toContain("sp");
    expect(results.find((r) => r.chunk_id === "sp")?.source).toBe("sparse");
  });

  it("no-op without querySparse (sparse chunk stays unrecovered)", async () => {
    const db = db0();
    addChunk(db, "seed", "S.md", vd(0.99));
    addChunk(db, "sp", "SP.md", vd(0.0), { obsidian: 0.9 });
    const results = await graphSearch(db, {
      query: "x",
      queryVec: [1, 0, 0, 0],
      vaultId: VAULT,
      seedCount: 1,
      finalTopK: 10,
      router: { enabled: false },
      lexical: { enabled: false },
    });
    expect(results.map((r) => r.chunk_id)).not.toContain("sp");
  });
});
