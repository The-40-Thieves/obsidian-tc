// ADR-0007 class (b): the per-vault index statistics the derivation reads. Cheap indexed COUNTs,
// scoped to ONE vault in a shared cache.db, cached against the vault generation.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { bumpGeneration } from "../src/search/generation";
import { readVaultIndexStats } from "../src/search/vault-index-stats";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);

function seedDb(withEdges = true): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  if (withEdges) {
    db.exec(
      `CREATE TABLE vault_edges (
         source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
         edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT, vault_id TEXT NOT NULL DEFAULT '',
         created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
       );`,
    );
  }
  db.exec(
    "CREATE TABLE vault_generation (vault_id TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0)",
  );
  return db;
}

let n = 0;
function chunk(db: Database, vault: string, path: string): void {
  n += 1;
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(`c${n}`, vault, path, "0", "[]", "x", `h${n}`, 1, 0, 0);
}
function edge(db: Database, vault: string, src: string, dst: string, kind = "literal"): void {
  db.prepare(
    "INSERT INTO vault_edges (source_path, target_path, edge_type, edge_kind, vault_id, created_at, updated_at) VALUES (?, ?, 'links_to', ?, ?, 0, 0)",
  ).run(src, dst, kind, vault);
}

describe("readVaultIndexStats", () => {
  it("counts chunks, notes, authored edges and derives the ratios — for ONE vault only", () => {
    const db = seedDb();
    for (const p of ["a.md", "b.md"]) for (let i = 0; i < 3; i++) chunk(db, "v1", p);
    chunk(db, "v2", "other.md");
    edge(db, "v1", "a.md", "b.md");
    edge(db, "v1", "b.md", "a.md");
    edge(db, "v1", "a.md", "b.md", "derived"); // derived plane does not count as authored link density
    edge(db, "v2", "other.md", "a.md");
    expect(readVaultIndexStats(db, "v1")).toEqual({
      vaultId: "v1",
      chunkCount: 6,
      noteCount: 2,
      edgeCount: 2,
      avgChunksPerNote: 3,
      edgesPerNote: 1,
    });
    expect(readVaultIndexStats(db, "v2")?.chunkCount).toBe(1);
  });

  it("an empty vault is zeros with zero ratios (not NaN)", () => {
    const db = seedDb();
    expect(readVaultIndexStats(db, "empty")).toEqual({
      vaultId: "empty",
      chunkCount: 0,
      noteCount: 0,
      edgeCount: 0,
      avgChunksPerNote: 0,
      edgesPerNote: 0,
    });
  });

  it("a db without vault_edges still yields chunk stats (edge stats zero)", () => {
    const db = seedDb(false);
    chunk(db, "v1", "a.md");
    expect(readVaultIndexStats(db, "v1")).toMatchObject({
      chunkCount: 1,
      noteCount: 1,
      edgeCount: 0,
    });
  });

  it("a db without a chunks table yields null (missing stats, never a guess)", () => {
    const db = openMemoryDb();
    expect(readVaultIndexStats(db, "v1")).toBeNull();
  });

  it("is cached against the vault generation and refreshed when it bumps", () => {
    const db = seedDb();
    chunk(db, "v1", "a.md");
    bumpGeneration(db, "v1");
    expect(readVaultIndexStats(db, "v1")?.chunkCount).toBe(1);
    chunk(db, "v1", "b.md");
    // Same generation: served from cache (a write that did not bump is not yet visible).
    expect(readVaultIndexStats(db, "v1")?.chunkCount).toBe(1);
    bumpGeneration(db, "v1");
    expect(readVaultIndexStats(db, "v1")?.chunkCount).toBe(2);
  });

  it("the cache expires after its TTL even when the generation never moves", () => {
    const db = seedDb();
    chunk(db, "v1", "a.md");
    let now = 1_000;
    expect(readVaultIndexStats(db, "v1", { now: () => now })?.chunkCount).toBe(1);
    chunk(db, "v1", "b.md");
    now += 10_000;
    expect(readVaultIndexStats(db, "v1", { now: () => now })?.chunkCount).toBe(1);
    now += 10 * 60_000;
    expect(readVaultIndexStats(db, "v1", { now: () => now })?.chunkCount).toBe(2);
  });

  it("caches per database handle (two dbs never share an entry)", () => {
    const a = seedDb();
    const b = seedDb();
    chunk(a, "v1", "a.md");
    expect(readVaultIndexStats(a, "v1")?.chunkCount).toBe(1);
    expect(readVaultIndexStats(b, "v1")?.chunkCount).toBe(0);
  });
});
