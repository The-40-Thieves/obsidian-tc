// THE-388 — ColBERT late-interaction rerank of the fused top-K in graph_search. With queryColbert +
// stored chunk_colbert, the fused head is reordered by maxSim; without it, the dense/RRF order stands.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { ensureChunkColbert, upsertChunkColbert } from "../src/search/chunk_colbert";
import type { ColbertMatrix } from "../src/search/colbert";
import { graphSearch } from "../src/search/graph_search";
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
  ensureChunkColbert(db);
  return db;
}

function addChunk(
  db: Database,
  id: string,
  path: string,
  vec: number[],
  colbert?: ColbertMatrix,
): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, '0', '[]', ?, ?, 1, 0, 0)",
  ).run(id, VAULT, path, `body ${id}`, `h-${id}`);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, 0)",
  ).run(id, "test:embed", vec.length, floatBlob(vec));
  if (colbert) upsertChunkColbert(db, id, VAULT, colbert);
}

const opts = (extra: Record<string, unknown>) => ({
  query: "x",
  queryVec: [1, 0, 0, 0],
  vaultId: VAULT,
  seedCount: 2,
  finalTopK: 10,
  router: { enabled: false },
  lexical: { enabled: false },
  ...extra,
});

describe("ColBERT rerank of the fused top-K in graph_search (THE-388)", () => {
  it("promotes the strong-maxSim chunk above a higher-cosine chunk when queryColbert is supplied", async () => {
    const db = db0();
    // a leads on cosine but its ColBERT token is orthogonal to the query; b trails on cosine but its
    // ColBERT token is aligned — so the late-interaction rerank must lift b above a.
    addChunk(db, "a", "A.md", vd(0.95), [[0, 1, 0, 0]]);
    addChunk(db, "b", "B.md", vd(0.9), [[1, 0, 0, 0]]);
    const results = await graphSearch(db, opts({ queryColbert: [[1, 0, 0, 0]] }));
    const ids = results.map((r) => r.chunk_id);
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("a"));
  });

  it("no-op without queryColbert (dense/RRF order preserved)", async () => {
    const db = db0();
    addChunk(db, "a", "A.md", vd(0.95), [[0, 1, 0, 0]]);
    addChunk(db, "b", "B.md", vd(0.9), [[1, 0, 0, 0]]);
    const results = await graphSearch(db, opts({}));
    const ids = results.map((r) => r.chunk_id);
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
  });
});
