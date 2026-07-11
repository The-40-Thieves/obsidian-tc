// THE-233 integration: verify the MERGED migration chain applies clean on a fresh db AND on a
// db that already has the pre-merge migrations (simulating an existing dev cache.db). Guards
// the cli.ts migration array assembled across W-SCHEMA + W-WORKERS.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { openMemoryDb } from "./helpers";

function read(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
}

// The cache.db chain, in monotonic version order, exactly as cli.ts assembles it.
const cacheChain = [
  { version: "20260519_001", sql: read("20260519_001_initial.sql") },
  { version: "20260519_002", sql: read("20260519_002_entity_unique.sql") },
  { version: "20260626_001", sql: read("20260626_001_vault_edges.sql") },
  { version: "20260626_002", sql: read("20260626_002_plane.sql") },
  { version: "20260703_001", sql: read("20260703_001_vault_edges_vault_id.sql") },
];
const experientialChain = [
  { version: "20260626_001", sql: read("20260626_001_experiential_init.sql") },
  { version: "20260711_001", sql: read("20260711_001_experiential_outcome.sql") },
];

function tableExists(db: Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

describe("merged migration chain (integration)", () => {
  it("cache.db: full chain applies on a fresh db, all tables present, idempotent", () => {
    const db = openMemoryDb();
    expect(runMigrations(db, cacheChain)).toEqual([
      "20260519_001",
      "20260519_002",
      "20260626_001",
      "20260626_002",
      "20260703_001",
    ]);
    for (const t of [
      "chunks",
      "chunk_embeddings",
      "memory_entities",
      "vault_edges",
      "contradictions",
      "syntheses",
      "audit_reports",
      "job_runs",
    ]) {
      expect(tableExists(db, t)).toBe(true);
    }
    expect(runMigrations(db, cacheChain)).toEqual([]); // idempotent re-run
  });

  it("cache.db: on an existing db (pre-merge migrations applied), only the new ones apply", () => {
    const db = openMemoryDb();
    runMigrations(db, cacheChain.slice(0, 2)); // simulate the current dev cache.db (001 + 002)
    expect(runMigrations(db, cacheChain)).toEqual(["20260626_001", "20260626_002", "20260703_001"]);
    expect(tableExists(db, "vault_edges")).toBe(true);
    expect(tableExists(db, "contradictions")).toBe(true);
  });

  it("experiential.db: the separate-store chain applies (the membrane)", () => {
    const db = openMemoryDb();
    expect(runMigrations(db, experientialChain)).toEqual(["20260626_001", "20260711_001"]);
    expect(tableExists(db, "vault_object_state")).toBe(true);
    expect(tableExists(db, "chunk_retrievals")).toBe(true);
    // THE-230 outcome axis present and writable
    db.prepare(
      "INSERT INTO chunk_retrievals (id, chunk_id, retrieved_at, outcome) VALUES ('x', 'c', 1, 1)",
    ).run();
    const row = db.prepare("SELECT outcome FROM chunk_retrievals WHERE id = 'x'").get() as {
      outcome: number;
    };
    expect(row.outcome).toBe(1);
    expect(runMigrations(db, experientialChain)).toEqual([]); // idempotent re-run
  });
});
