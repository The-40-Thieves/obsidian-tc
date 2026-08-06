// THE-695 item 2 — the BM25 over-fetch boundary leaks the returned LENGTH.
//
// `bm25Chunks` over-fetches F = k*20 + 50, filters in JS, then cuts to k. The returned length is
// min(k, R_F) where R_F is the readable rows inside the top-F MATCH prefix. When it UNDERFILLS,
// that is because excluded rows outranked the caller's — so the length depends on hidden content.
//
// An earlier analysis computed the window as a share of the whole corpus (~4.8% of 13,439 chunks)
// and concluded "safe today". Wrong denominator: what matters is the hidden fraction of the top-F
// MATCH prefix, and underfill begins once that exceeds 1 - k/F (98.57% at k=1, 96% at k=10).
// Reproduced at k=1: 69 higher-scoring hidden matches return the readable row, 70 return nothing.
// One row's existence flips the length.
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

/** Hidden rows carry the term ONCE and readable rows carry it many times, so bm25 ranks the short
 *  hidden docs above the long readable one — which is the ordering that produces underfill. */
function seeded(hiddenCount: number): Database {
  const db = openMemoryDb();
  // The REAL initial migration, not a hand-rolled schema: ensureChunkFts records a pseudo-migration
  // row, so it needs schema_migrations, and a bespoke fixture would drift from production anyway.
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  db.exec(
    "CREATE TABLE acl_path_sets (set_id INTEGER PRIMARY KEY, acl_fingerprint TEXT NOT NULL, vault_id TEXT NOT NULL, generation INTEGER NOT NULL, built_at INTEGER NOT NULL, path_count INTEGER NOT NULL, UNIQUE (acl_fingerprint, vault_id))",
  );
  db.exec(
    "CREATE TABLE acl_path_members (set_id INTEGER NOT NULL REFERENCES acl_path_sets(set_id) ON DELETE CASCADE, path TEXT NOT NULL, PRIMARY KEY (set_id, path)) WITHOUT ROWID",
  );
  db.prepare("INSERT INTO acl_path_sets VALUES (1,'fp','main',1,1,1)").run();
  db.prepare("INSERT INTO acl_path_members VALUES (1,'02-visible.md')").run();

  const addChunk = db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'main', ?, '0', '[]', ?, ?, 1, 0, 0)",
  );
  for (let i = 0; i < hiddenCount; i++) {
    addChunk.run(`h${i}`, "09-hidden.md", "needle", `hh${i}`);
  }
  const long = `needle ${"filler ".repeat(40)}`;
  addChunk.run("v1", "02-visible.md", long, "hv1");

  // THE-711 follow-up: the index is built AFTER the chunks, by ensureChunkFts's own
  // count-divergence rebuild — the same path production takes. This fixture used to hand-write
  // `INSERT INTO chunk_fts (vault_id, chunk_id, path, content)`, which a contentless table has no
  // columns for; building it through the real function means the fixture cannot drift from the
  // production shape again.
  if (!ensureChunkFts(db)) {
    throw new Error(
      "FTS5 unavailable — THE-695's assertions cannot run. Refusing to pass vacuously.",
    );
  }
  return db;
}

const readable = (p: string): boolean => p === "02-visible.md";

describe("THE-695 bm25 over-fetch boundary", () => {
  it("underfills today once hidden rows fill the over-fetch window", () => {
    // k=1 -> F = 70. With 70 higher-ranked hidden rows the readable row falls outside the window.
    // This case documents the DEFECT and is expected to pass before and after the fix is available
    // — it is what makes the next test non-vacuous.
    const db = seeded(70);
    expect(bm25Chunks(db, "main", "needle", 1, readable)).toStrictEqual([]);
    db.close?.();
  });

  it("finds the readable row regardless of hidden volume when the set is joined", () => {
    const db = seeded(70);
    const hits = bm25Chunks(db, "main", "needle", 1, readable, 1);
    expect(hits.map((h) => h.path)).toStrictEqual(["02-visible.md"]);
    db.close?.();
  });

  it("is unaffected by hidden volume at all — 70 hidden and 500 hidden agree", () => {
    // The non-interference statement: the readable answer must not be a function of how much
    // denied content matched.
    const few = bm25Chunks(seeded(70), "main", "needle", 1, readable, 1).map((h) => h.path);
    const many = bm25Chunks(seeded(500), "main", "needle", 1, readable, 1).map((h) => h.path);
    expect(many).toStrictEqual(few);
    expect(many).toStrictEqual(["02-visible.md"]);
  });

  it("agrees with the JS-filtered path at a hidden volume that path still handles", () => {
    const db = seeded(5);
    const withSet = bm25Chunks(db, "main", "needle", 1, readable, 1);
    const withoutSet = bm25Chunks(db, "main", "needle", 1, readable);
    expect(withSet.map((h) => h.path)).toStrictEqual(withoutSet.map((h) => h.path));
    expect(withSet.map((h) => h.path)).toStrictEqual(["02-visible.md"]);
    db.close?.();
  });

  it("returns content from chunks, not the enriched FTS copy", () => {
    // THE-406: match/rank on chunk_fts.content but RETURN chunks.content, so enrichment never
    // leaks into search output. The joined path must preserve that.
    const db = seeded(3);
    const hits = bm25Chunks(db, "main", "needle", 1, readable, 1);
    expect(hits[0]?.content).toContain("filler");
    db.close?.();
  });
});
