// THE-398 — score-normalized convex-combination fusion. Pins the property RRF cannot have:
// alpha weighs RAW normalized magnitudes, so alpha=1 is pure (normalized) dense order and
// alpha=0 is pure lexical order — where RRF's rank-only view lets a double-stream chunk beat
// the top dense hit regardless. Requires FTS5 for the lexical stream; self-skips without it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { ensureChunkFts } from "../src/search/chunk_fts";
import { graphSearch } from "../src/search/graph_search";
import { floatBlob } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "v1";
const QUERY_VEC = [1, 0, 0, 0];

function vd(cos: number): number[] {
  return [cos, Math.sqrt(1 - cos * cos), 0, 0];
}

function addChunk(db: Database, id: string, path: string, content: string, vec: number[]): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, VAULT, path, "0", "[]", content, `h-${id}`, 1, 0, 0);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, 0)",
  ).run(id, "test:embed", vec.length, floatBlob(vec));
}

// A (top cosine, no keyword), B (near-tied cosine + keyword match), C (low-cosine spacer so the
// seed-pool min-max does not zero B), L (lexical-only: keyword but cosine 0 — never a seed).
function corpus(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  db.exec(
    `CREATE TABLE vault_edges (
       source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
       edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT, vault_id TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
     );`,
  );
  addChunk(db, "cA", "A.md", "dense answer no keyword here", vd(0.99));
  addChunk(db, "cB", "B.md", "quokka habitat notes", vd(0.98));
  addChunk(db, "cC", "C.md", "spacer text", vd(0.1));
  addChunk(db, "cL", "L.md", "quokka quokka quokka", vd(0.0));
  return db;
}

async function order(db: Database, mode: "rrf" | 1 | 0): Promise<string[]> {
  const res = await graphSearch(db, {
    query: "quokka",
    queryVec: QUERY_VEC,
    vaultId: VAULT,
    seedCount: 3,
    finalTopK: 10,
    router: { enabled: false },
    ...(mode === "rrf" ? {} : { fusionMode: "convex" as const, convex: { alpha: mode } }),
  });
  return res.map((r) => r.path);
}

describe("THE-398 convex-combination fusion", () => {
  it("alpha=1 is pure normalized-dense order; RRF's rank-only fusion inverts it", async () => {
    const db = corpus();
    if (!ensureChunkFts(db)) return; // FTS5 not compiled into this runtime
    // RRF: B rides two streams (seed rank 1 + lexical) and outranks the top dense hit A.
    const rrf = await order(db, "rrf");
    expect(rrf.indexOf("B.md")).toBeLessThan(rrf.indexOf("A.md"));
    // Convex alpha=1: only normalized dense magnitude counts — A (cos .99) stays on top.
    const dense = await order(db, 1);
    expect(dense.indexOf("A.md")).toBeLessThan(dense.indexOf("B.md"));
  });

  it("alpha=0 is pure lexical order — the keyword-only chunk beats every dense hit", async () => {
    const db = corpus();
    if (!ensureChunkFts(db)) return;
    const lex = await order(db, 0);
    expect(lex.indexOf("L.md")).toBe(0);
    expect(lex).toContain("A.md"); // dense candidates remain in the list (score 0), never dropped
  });
});
