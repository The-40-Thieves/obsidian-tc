// THE-388 — bge-m3 learned-sparse retrieval (storage + scorer + search). Exercised with hand-built
// weight maps; the bge-m3 encoder that produces them is separate and infra-gated.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import {
  deleteChunkSparse,
  ensureChunkSparse,
  sparseDot,
  sparseSearch,
  upsertChunkSparse,
} from "../src/search/sparse";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "v1";

function db0(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  return db;
}

function addChunkRow(db: Database, id: string, path: string): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, '0', '[]', ?, ?, 1, 0, 0)",
  ).run(id, VAULT, path, `body ${id}`, `h-${id}`);
}

describe("sparse retrieval (THE-388)", () => {
  it("sparseDot sums over shared token ids only", () => {
    expect(sparseDot({ a: 1, b: 2, c: 3 }, { b: 5, c: 1, d: 9 })).toBe(2 * 5 + 3 * 1);
    expect(sparseDot({}, { a: 1 })).toBe(0);
    expect(sparseDot({ a: 1 }, { b: 1 })).toBe(0);
  });

  it("sparseSearch returns [] when chunk_sparse is absent or the query is empty", () => {
    const db = db0();
    expect(sparseSearch(db, VAULT, { a: 1 }, 10)).toEqual([]); // table not provisioned
    ensureChunkSparse(db);
    expect(sparseSearch(db, VAULT, {}, 10)).toEqual([]); // empty query
  });

  it("ranks chunks by sparse dot product, dropping zero-overlap chunks", () => {
    const db = db0();
    ensureChunkSparse(db);
    addChunkRow(db, "c1", "A.md");
    addChunkRow(db, "c2", "B.md");
    addChunkRow(db, "c3", "C.md");
    upsertChunkSparse(db, "c1", VAULT, { obsidian: 0.9, note: 0.3 });
    upsertChunkSparse(db, "c2", VAULT, { obsidian: 0.2, graph: 0.8 });
    upsertChunkSparse(db, "c3", VAULT, { unrelated: 1.0 });
    const hits = sparseSearch(db, VAULT, { obsidian: 1.0 }, 10);
    expect(hits.map((h) => h.chunk_id)).toEqual(["c1", "c2"]); // c3 has zero overlap
    expect(hits[0]?.score).toBeCloseTo(0.9);
  });

  it("upsert overwrites weights and delete removes the row", () => {
    const db = db0();
    ensureChunkSparse(db);
    addChunkRow(db, "c1", "A.md");
    upsertChunkSparse(db, "c1", VAULT, { x: 1 });
    upsertChunkSparse(db, "c1", VAULT, { y: 2 }); // overwrite
    expect(sparseSearch(db, VAULT, { x: 1 }, 10)).toEqual([]); // old weights gone
    expect(sparseSearch(db, VAULT, { y: 1 }, 10).map((h) => h.chunk_id)).toEqual(["c1"]);
    deleteChunkSparse(db, "c1");
    expect(sparseSearch(db, VAULT, { y: 1 }, 10)).toEqual([]);
  });
});
