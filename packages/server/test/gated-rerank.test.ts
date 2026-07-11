// THE-394 — gated cross-encoder rerank. Proves: (1) an easy query (confident top-1 seed) never
// pays the reranker call, (2) a hard query reranks the head of the fused list and keeps the
// remainder in RRF order below, (3) disabled / absent reranker preserves pure RRF behavior.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { graphSearch } from "../src/search/graph_search";
import type { Reranker } from "../src/search/rerank";
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

function spyReranker(): { reranker: Reranker; calls: Array<{ query: string; docs: string[] }> } {
  const calls: Array<{ query: string; docs: string[] }> = [];
  const reranker: Reranker = async (query, documents) => {
    calls.push({ query, docs: documents });
    // Reverse the incoming order with descending scores.
    return documents.map((_, i) => ({
      index: documents.length - 1 - i,
      relevanceScore: 1 - i * 0.1,
    }));
  };
  return { reranker, calls };
}

const BASE = {
  query: "anything at all",
  queryVec: [1, 0, 0, 0],
  vaultId: VAULT,
  finalTopK: 10,
  router: { enabled: false as const },
  lexical: { enabled: false as const },
};

function hardDb(): Database {
  const db = seedDb();
  addChunk(db, "a", "A.md", "alpha content", vd(0.4)); // top-1 = 0.4 < 0.55 -> hard
  addChunk(db, "b", "B.md", "beta content", vd(0.35));
  addChunk(db, "c", "C.md", "gamma content", vd(0.3));
  return db;
}

describe("THE-394 gated rerank", () => {
  it("an easy query (confident top-1) never calls the reranker", async () => {
    const db = seedDb();
    addChunk(db, "a", "A.md", "alpha content", vd(0.99)); // top-1 well above the gate
    addChunk(db, "b", "B.md", "beta content", vd(0.4));
    const { reranker, calls } = spyReranker();
    const out = await graphSearch(db, {
      ...BASE,
      seedCount: 2,
      reranker,
      gatedRerank: { enabled: true },
    });
    expect(calls).toHaveLength(0);
    expect(out.map((r) => r.chunk_id)).toEqual(["a", "b"]);
  });

  it("a hard query reranks the head and keeps the remainder in RRF order", async () => {
    const db = hardDb();
    const { reranker, calls } = spyReranker();
    const out = await graphSearch(db, {
      ...BASE,
      seedCount: 3,
      reranker,
      gatedRerank: { enabled: true, pool: 2 }, // rerank only the top-2; c stays below
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.docs).toEqual(["alpha content", "beta content"]);
    // Spy reverses the head: b above a; c untouched below.
    expect(out.map((r) => r.chunk_id)).toEqual(["b", "a", "c"]);
  });

  it("disabled gate and absent reranker both preserve pure RRF order", async () => {
    const db = hardDb();
    const { reranker, calls } = spyReranker();
    const disabled = await graphSearch(db, { ...BASE, seedCount: 3, reranker });
    expect(calls).toHaveLength(0);
    expect(disabled.map((r) => r.chunk_id)).toEqual(["a", "b", "c"]);
    const noBackend = await graphSearch(db, {
      ...BASE,
      seedCount: 3,
      gatedRerank: { enabled: true },
    });
    expect(noBackend.map((r) => r.chunk_id)).toEqual(["a", "b", "c"]);
  });
});
