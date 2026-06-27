import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { runAudit } from "../src/plane/jobs/audit";
import { openMemoryDb } from "./helpers";

const INIT = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);

function chunk(db: Database, id: string, path: string, idx: string): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'v1', ?, ?, '[]', 'c', ?, 1, 0, 0)",
  ).run(id, path, idx, `h-${id}`);
}
function emb(db: Database, id: string): void {
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, 'm', 1, ?, 1, 0)",
  ).run(id, new Uint8Array([0, 0, 0, 0]));
}

describe("audit job (kb-audit-worker collapse)", () => {
  it("counts null embeddings + duplicate chunk positions and writes a report", () => {
    const db = openMemoryDb();
    runMigrations(db, [{ version: "20260519_001", sql: INIT }]);
    db.exec(
      "CREATE TABLE audit_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, report_type TEXT NOT NULL, created_at INTEGER NOT NULL, has_issues INTEGER NOT NULL, summary TEXT, report TEXT NOT NULL);",
    );
    chunk(db, "a", "A.md", "0");
    emb(db, "a"); // has embedding
    chunk(db, "b", "B.md", "0"); // null embedding
    chunk(db, "c1", "C.md", "0");
    chunk(db, "c2", "C.md", "0"); // duplicate (C.md, 0)
    emb(db, "c1");
    emb(db, "c2");

    const { report, hasIssues } = runAudit(db, () => 1);
    expect(report.vault_null_embeddings).toBe(1);
    expect(report.duplicate_chunk_positions).toBe(1);
    expect(hasIssues).toBe(true);
    const count = db.prepare("SELECT COUNT(*) AS c FROM audit_reports").get() as { c: number };
    expect(count.c).toBe(1);
  });
});
