import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import type { GatewayRoles } from "../src/plane/gateway";
import {
  checkContradictions,
  groupContradictionQueue,
  type IndexedChunk,
  parseVerdict,
} from "../src/plane/jobs/contradiction";
import { floatBlob } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

const INIT = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);

function rolesReturning(text: string): GatewayRoles {
  const r = async () => ({ text, model: "mock" });
  return { extract: r, synthesize: r, judge: r };
}

function addChunk(db: Database, id: string, path: string, vec: number[]): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'v1', ?, '0', '[]', ?, ?, 1, 0, 0)",
  ).run(id, path, `body ${id}`, `h-${id}`);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, 'm', ?, ?, 1, 0)",
  ).run(id, vec.length, floatBlob(vec));
}

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

describe("contradiction detector (judge seam + sqlite-vec neighbors)", () => {
  it("flags a conflicting neighbor in the cosine band; near-dupes excluded", async () => {
    const db = baseDb();
    addChunk(db, "a", "A.md", [1, 0, 0]);
    addChunk(db, "b", "B.md", [0.95, 0.312, 0]); // cosine ~0.95 with A -> in [0.85, 0.99)
    addChunk(db, "dupe", "D.md", [1, 0, 0]); // cosine 1.0 -> near-dupe, excluded
    const roles = rolesReturning('{"kind":"contradiction","rationale":"A negates B"}');
    const stats = await checkContradictions({ db, roles, now: () => 1 }, "v1", [
      { id: "a", path: "A.md", content: "alpha", embedding: [1, 0, 0] },
    ]);
    expect(stats.flagged).toBe(1);
    const row = db.prepare("SELECT judge_verdict, status FROM contradictions").get() as {
      judge_verdict: string;
      status: string;
    };
    expect(row.judge_verdict).toBe("contradiction");
    expect(row.status).toBe("open");
  });

  it("does nothing when roles are disabled, and parseVerdict falls back safely", async () => {
    const db = baseDb();
    addChunk(db, "a", "A.md", [1, 0, 0]);
    const stats = await checkContradictions({ db, roles: null, now: () => 1 }, "v1", [
      { id: "a", path: "A.md", content: "alpha", embedding: [1, 0, 0] },
    ]);
    expect(stats.flagged).toBe(0);
    expect(parseVerdict("not json").kind).toBe("no_conflict");
  });
});

describe("groupContradictionQueue (THE-457 continuous drain)", () => {
  const chunk = (id: string): IndexedChunk => ({
    id,
    path: `${id}.md`,
    content: id,
    embedding: [],
  });

  it("groups drained items by vault", () => {
    const g = groupContradictionQueue([
      { vaultId: "a", chunk: chunk("1") },
      { vaultId: "b", chunk: chunk("2") },
      { vaultId: "a", chunk: chunk("3") },
    ]);
    expect(g.get("a")?.map((c) => c.id)).toEqual(["1", "3"]);
    expect(g.get("b")?.map((c) => c.id)).toEqual(["2"]);
  });

  it("dedups a chunk re-enqueued by rapid re-indexes (judged once per drain)", () => {
    const g = groupContradictionQueue([
      { vaultId: "a", chunk: chunk("1") },
      { vaultId: "a", chunk: chunk("1") },
      { vaultId: "a", chunk: chunk("1") },
    ]);
    expect(g.get("a")).toHaveLength(1);
  });

  it("keeps the same chunk id independent across vaults", () => {
    const g = groupContradictionQueue([
      { vaultId: "a", chunk: chunk("1") },
      { vaultId: "b", chunk: chunk("1") },
    ]);
    expect(g.get("a")).toHaveLength(1);
    expect(g.get("b")).toHaveLength(1);
  });
});
