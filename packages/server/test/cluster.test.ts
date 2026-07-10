// THE-73 Phase 2 — KMeans clustering + graph_search per-cluster diversification cap.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { assignClusters, defaultK, kmeans } from "../src/search/cluster";
import { graphSearch } from "../src/search/graph_search";
import { floatBlob } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "v1";

function db0(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  db.exec(
    `CREATE TABLE vault_edges (
       source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
       edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT, vault_id TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
     );`,
  );
  return db;
}

function addChunk(db: Database, id: string, path: string, vec: number[]): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, VAULT, path, "0", "[]", `body ${id}`, `h-${id}`, 1, 0, 0);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, 0)",
  ).run(id, "test:embed", vec.length, floatBlob(vec));
}

describe("kmeans + cluster diversification (THE-73 Phase 2)", () => {
  it("separates two well-separated groups and is deterministic", () => {
    const vecs = [
      [1, 0, 0, 0],
      [0.98, 0.02, 0, 0],
      [0.97, 0, 0.01, 0],
      [0, 1, 0, 0],
      [0.02, 0.98, 0, 0],
      [0, 0.97, 0.01, 0],
    ];
    const a = kmeans(vecs, 2, { seed: 7 });
    const b = kmeans(vecs, 2, { seed: 7 });
    expect(a.assignments).toEqual(b.assignments); // deterministic
    expect(new Set(a.assignments.slice(0, 3)).size).toBe(1);
    expect(new Set(a.assignments.slice(3, 6)).size).toBe(1);
    expect(a.assignments[0]).not.toBe(a.assignments[3]);
  });

  it("defaultK is ~sqrt(n), clamped to [1, 256]", () => {
    expect(defaultK(0)).toBe(1);
    expect(defaultK(100)).toBe(10);
    expect(defaultK(1_000_000)).toBe(256);
  });

  it("assignClusters persists a cluster_id for every active chunk", () => {
    const db = db0();
    addChunk(db, "a1", "A1.md", [1, 0, 0, 0]);
    addChunk(db, "a2", "A2.md", [0.98, 0.02, 0, 0]);
    addChunk(db, "b1", "B1.md", [0, 1, 0, 0]);
    addChunk(db, "b2", "B2.md", [0.02, 0.98, 0, 0]);
    const stats = assignClusters(db, VAULT, { k: 2, seed: 7 });
    expect(stats?.chunks).toBe(4);
    const rows = db
      .prepare("SELECT id, cluster_id FROM chunks WHERE vault_id = ? ORDER BY id")
      .all(VAULT) as Array<{ id: string; cluster_id: number | null }>;
    expect(rows.every((r) => r.cluster_id !== null)).toBe(true);
    const byId = new Map(rows.map((r) => [r.id, r.cluster_id]));
    expect(byId.get("a1")).toBe(byId.get("a2"));
    expect(byId.get("b1")).toBe(byId.get("b2"));
    expect(byId.get("a1")).not.toBe(byId.get("b1"));
  });

  it("assignClusters returns null for a vault with no chunks", () => {
    expect(assignClusters(db0(), VAULT)).toBeNull();
  });

  it("graph_search maxPerCluster caps near-duplicate cluster members", async () => {
    const db = db0();
    addChunk(db, "d0", "D0.md", [0.99, 0.01, 0, 0]);
    addChunk(db, "d1", "D1.md", [0.98, 0.02, 0, 0]);
    addChunk(db, "d2", "D2.md", [0.97, 0.03, 0, 0]);
    addChunk(db, "d3", "D3.md", [0.96, 0.04, 0, 0]);
    addChunk(db, "o0", "O0.md", [0, 1, 0, 0]);
    assignClusters(db, VAULT, { k: 2, seed: 7 });
    const common = {
      query: "x",
      queryVec: [1, 0, 0, 0],
      vaultId: VAULT,
      seedCount: 10,
      finalTopK: 10,
      router: { enabled: false },
      lexical: { enabled: false },
    };
    const uncapped = await graphSearch(db, common);
    const capped = await graphSearch(db, { ...common, maxPerCluster: 2 });
    expect(uncapped.length).toBe(5);
    expect(capped.length).toBeLessThan(uncapped.length);
    const rows = db
      .prepare("SELECT id, cluster_id FROM chunks WHERE vault_id = ?")
      .all(VAULT) as Array<{ id: string; cluster_id: number }>;
    const cl = new Map(rows.map((r) => [r.id, r.cluster_id]));
    const counts = new Map<number, number>();
    for (const r of capped) {
      const c = cl.get(r.chunk_id) as number;
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    for (const nInCluster of counts.values()) expect(nInCluster).toBeLessThanOrEqual(2);
  });
});
