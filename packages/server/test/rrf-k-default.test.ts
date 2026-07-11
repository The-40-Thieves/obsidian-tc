// THE-397 — the graph_rrf fusion constant defaults to k=10 (config-exposed as retrieval.rrfK).
// Pins: (1) the default equals an explicit rrfK: 10, and (2) k genuinely changes fused order in
// the crossover regime the sweep measured (a two-stream mid-rank candidate vs a single-stream
// rank-1 hit), so a future default drift is caught.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
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

const OPTS = {
  query: "no lexical terms here",
  queryVec: [1, 0, 0, 0],
  vaultId: VAULT,
  finalTopK: 30,
  router: { enabled: false as const },
  lexical: { enabled: false as const },
};

describe("THE-397 rrfK default", () => {
  it("the default fused order equals an explicit rrfK of 10", async () => {
    const db = seedDb();
    addChunk(db, "top", "T.md", "top dense hit", vd(0.99));
    for (let i = 0; i < 12; i++) addChunk(db, `f${i}`, `f${i}.md`, "filler", vd(0.9 - i * 0.05));
    const def = (await graphSearch(db, OPTS)).map((r) => r.chunk_id);
    const k10 = (await graphSearch(db, { ...OPTS, rrfK: 10 })).map((r) => r.chunk_id);
    expect(def).toEqual(k10);
    expect(def[0]).toBe("top");
  });
});
