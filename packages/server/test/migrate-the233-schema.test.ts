import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { provisionExperientialDb } from "../src/db/experiential";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { openMemoryDb } from "./helpers";

function readMigration(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/migrations/${name}`, import.meta.url)), "utf8");
}
const VAULT_EDGES_SQL = readMigration("20260626_001_vault_edges.sql");
const EXPERIENTIAL_SQL = readMigration("20260626_001_experiential_init.sql");

function tableExists(db: any, name: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}
function columns(db: any, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

describe("THE-233 W-SCHEMA migrations", () => {
  it("vault_edges: creates the edge table + unique constraint (cache.db tier)", () => {
    const db = openMemoryDb();
    const applied = runMigrations(db, [{ version: "20260626_001", sql: VAULT_EDGES_SQL }]);
    expect(applied).toEqual(["20260626_001"]);
    expect(tableExists(db, "vault_edges")).toBe(true);
    const insert = db.prepare(
      "INSERT INTO vault_edges (source_path, target_path, edge_type, edge_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run("a.md", "b.md", "links_to", "literal", 1, 1);
    // unique(source_path, target_path, edge_type) rejects the duplicate regardless of kind.
    expect(() => insert.run("a.md", "b.md", "links_to", "virtual", 2, 2)).toThrow();
  });

  it("experiential: creates object_state + chunk_retrievals with the ported columns", () => {
    const db = openMemoryDb();
    runMigrations(db, [{ version: "20260626_001", sql: EXPERIENTIAL_SQL }]);
    expect(tableExists(db, "vault_object_state")).toBe(true);
    expect(tableExists(db, "chunk_retrievals")).toBe(true);
    expect(columns(db, "vault_object_state")).toEqual(
      expect.arrayContaining([
        "object_id",
        "retrieval_strength",
        "storage_strength",
        "frequency",
        "valid_from",
        "valid_until",
        "emotional_weight",
        "cached_activation_score",
      ]),
    );
    expect(columns(db, "chunk_retrievals")).toEqual(
      expect.arrayContaining(["id", "chunk_id", "retrieved_at", "rerank_score", "feedback"]),
    );
  });

  it("is idempotent on re-run (no-op the second time)", () => {
    const db = openMemoryDb();
    const migs = [{ version: "20260626_001", sql: VAULT_EDGES_SQL }];
    expect(runMigrations(db, migs)).toEqual(["20260626_001"]);
    expect(runMigrations(db, migs)).toEqual([]);
  });

  it("provisionExperientialDb applies the experiential chain via an injected opener", async () => {
    const mem = openMemoryDb();
    const db: Database = await provisionExperientialDb(
      "/ignored",
      [{ version: "20260626_001", sql: EXPERIENTIAL_SQL }],
      { open: async () => mem as unknown as Database },
    );
    expect(tableExists(db, "vault_object_state")).toBe(true);
    expect(tableExists(db, "chunk_retrievals")).toBe(true);
  });
});
