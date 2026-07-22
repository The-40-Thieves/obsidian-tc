// THE-530: the brute-force fallback scored candidate embeddings by BYTE LENGTH alone, so a vector
// produced by a SUPERSEDED model at the same dimensionality was scored against a new-model query.
// is_active=1 and byteLength===dim*4 are both satisfied by an old-model vector after a same-dimension
// model swap — the exact condition THE-460 fixed on the vec0 path. Cosine between two models' vectors
// is a well-formed number that RANKS: confident wrong answers, no error, no log.
//
// Fix: thread the active model into SemanticOptions and filter it IN SQL (AND e.model = ?), so the
// brute-force scan and the vec0 path AGREE on excluding non-active-model vectors — restoring the
// THE-524 compatibility promise that the fallback returns the same answers, only slower.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { semanticSearch } from "../src/search/semantic";
import { floatBlob } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "v1";

function db(): Database {
  const d = openMemoryDb();
  runMigrations(d, [{ version: "init", sql: INIT_SQL }]);
  return d;
}

function addChunk(d: Database, id: string, path: string, vec: number[], model: string): void {
  d.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, VAULT, path, "0", "[]", `c-${id}`, `h-${id}`, 1, 0, 0);
  d.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, 0)",
  ).run(id, model, vec.length, floatBlob(vec));
}

describe("THE-530 brute-force model filter", () => {
  it("does not return a same-dimension vector from a non-active model", () => {
    const d = db();
    addChunk(d, "new", "new.md", [1, 0, 0], "model-v2"); // active model, aligned with query
    addChunk(d, "old", "old.md", [1, 0, 0], "model-v1"); // superseded model, SAME dim + same bytes

    // Query is embedded with the active model. Both rows have byteLength === dim*4 and is_active=1,
    // so the pre-fix scan scored both; only the active-model one may be returned.
    const hits = semanticSearch(d, VAULT, [1, 0, 0], { k: 10, model: "model-v2" });

    expect(hits.map((h) => h.path)).toEqual(["new.md"]);
    expect(hits.every((h) => h.embedding_model === "model-v2")).toBe(true);
  });

  it("still returns all rows when no active model is given (back-compat)", () => {
    const d = db();
    addChunk(d, "a", "a.md", [1, 0, 0], "model-v1");
    addChunk(d, "b", "b.md", [1, 0, 0], "model-v2");
    const hits = semanticSearch(d, VAULT, [1, 0, 0], { k: 10 });
    expect(hits.map((h) => h.path).sort()).toEqual(["a.md", "b.md"]);
  });

  it("excludes the old-model vector outright rather than surfacing it at score 0", () => {
    // The vec0 path (post-THE-460) excludes non-active-model vectors entirely; the two paths must
    // agree. A minScore-unset query must NOT surface the old-model note as a zero-score hit.
    const d = db();
    addChunk(d, "old", "old.md", [1, 0, 0], "model-v1");
    const hits = semanticSearch(d, VAULT, [1, 0, 0], { k: 10, model: "model-v2" });
    expect(hits).toEqual([]);
  });
});
