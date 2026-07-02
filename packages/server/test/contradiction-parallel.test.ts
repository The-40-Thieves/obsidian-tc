import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { checkContradictions } from "../src/plane/jobs/contradiction";
import { floatBlob } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

const INIT = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);

function baseDb(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT }]);
  db.exec(
    `CREATE TABLE contradictions (
       id TEXT PRIMARY KEY, source_chunk_id TEXT NOT NULL, source_path TEXT NOT NULL,
       conflict_chunk_id TEXT NOT NULL, conflict_path TEXT NOT NULL,
       source_content_sha TEXT NOT NULL, conflict_content_sha TEXT NOT NULL,
       cosine_similarity REAL, judge_verdict TEXT NOT NULL, judge_rationale TEXT,
       judge_model TEXT, status TEXT NOT NULL DEFAULT 'open', detected_at INTEGER NOT NULL,
       resolved_at INTEGER
     );
     CREATE UNIQUE INDEX idx_contradictions_pair ON contradictions(source_content_sha, conflict_content_sha);`,
  );
  return db;
}

function addChunk(db: Database, id: string, vec: number[]): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'v1', ?, '0', '[]', ?, ?, 1, 0, 0)",
  ).run(id, `${id}.md`, `body ${id}`, `h-${id}`);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, 'm', ?, ?, 1, 0)",
  ).run(id, vec.length, floatBlob(vec));
}

describe("THE-277 contradiction sweep parallelism", () => {
  it("judges neighbor pairs concurrently and flags each, preserving correctness", async () => {
    const db = baseDb();
    // three in-band neighbors of [1,0,0] (cosine in [0.85, 0.99), distinct, not near-dupes)
    addChunk(db, "n1", [0.95, 0.312, 0]);
    addChunk(db, "n2", [0.95, 0, 0.312]);
    addChunk(db, "n3", [0.9, 0.436, 0]);
    let inFlight = 0;
    let maxInFlight = 0;
    const judge = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return { text: '{"kind":"tension","rationale":"r"}', model: "mock" };
    };
    const roles = { extract: judge, synthesize: judge, judge };
    const stats = await checkContradictions({ db, roles, now: () => 1 }, "v1", [
      { id: "a", path: "A.md", content: "alpha", embedding: [1, 0, 0] },
    ]);
    expect(stats.flagged).toBe(3);
    expect(maxInFlight).toBeGreaterThan(1); // ran concurrently, not one pair at a time
    const rows = db.prepare("SELECT count(*) c FROM contradictions").get() as { c: number };
    expect(rows.c).toBe(3);
  });

  it("a single judge failure degrades to no_conflict without sinking the batch", async () => {
    const db = baseDb();
    addChunk(db, "n1", [0.95, 0.312, 0]);
    addChunk(db, "n2", [0.9, 0.436, 0]);
    let calls = 0;
    const judge = async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return { text: '{"kind":"contradiction","rationale":"r"}', model: "mock" };
    };
    const roles = { extract: judge, synthesize: judge, judge };
    const stats = await checkContradictions({ db, roles, now: () => 1 }, "v1", [
      { id: "a", path: "A.md", content: "alpha", embedding: [1, 0, 0] },
    ]);
    // one pair threw (-> no_conflict, not flagged), the other still flagged
    expect(stats.flagged).toBe(1);
  });
});
