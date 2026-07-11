// THE-401 — smooth expansion scoring. Pins the two discontinuities it removes:
// (1) hub suppression is continuous — a high-degree hub is demoted below a low-degree bridge
//     instead of hard-dropped (or, legacy default, ranked purely by cosine);
// (2) hop ordering is continuous — a strong 2-hop hit outranks a barely-gated 1-hop hit,
//     where the legacy lexicographic sort always puts ANY 1-hop first.
// Default off: the legacy order is byte-identical.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { graphSearch } from "../src/search/graph_search";
import { floatBlob } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "v1";
const QUERY_VEC = [1, 0, 0, 0];

function vd(cos: number): number[] {
  return [cos, Math.sqrt(1 - cos * cos), 0, 0];
}

function addChunk(db: Database, id: string, path: string, vec: number[]): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, VAULT, path, "0", "[]", `body ${id}`, `h-${id}`, 1, 0, 0);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, 0)",
  ).run(id, "test:embed", vec.length, floatBlob(vec));
}

function addEdge(db: Database, source: string, target: string): void {
  db.prepare(
    "INSERT INTO vault_edges (vault_id, source_path, target_path, edge_type, provenance, created_at, updated_at) VALUES (?, ?, ?, 'links_to', 'wikilink', 0, 0)",
  ).run(VAULT, source, target);
}

function baseDb(): Database {
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

async function order(db: Database, smooth: boolean): Promise<string[]> {
  const res = await graphSearch(db, {
    query: "fixture query",
    queryVec: QUERY_VEC,
    vaultId: VAULT,
    seedCount: 1,
    finalTopK: 10,
    router: { enabled: false },
    ...(smooth ? { smoothExpansion: { enabled: true } } : {}),
  });
  return res.map((r) => r.path);
}

describe("THE-401 smooth expansion scoring", () => {
  it("demotes a high-degree hub below a low-degree bridge (continuous, not a hard drop)", async () => {
    const db = baseDb();
    addChunk(db, "cS", "S.md", vd(0.95)); // the only seed (seedCount 1)
    addChunk(db, "cHub", "Hub.md", vd(0.9)); // 1-hop, pathological degree
    addChunk(db, "cBridge", "Bridge.md", vd(0.6)); // 1-hop, low degree
    addEdge(db, "S.md", "Hub.md");
    addEdge(db, "S.md", "Bridge.md");
    // Inflate Hub.md's degree well past hubMu=75 (targets need no chunks — degree is edge rows).
    for (let i = 0; i < 90; i++) addEdge(db, "Hub.md", `X${i}.md`);

    const legacy = await order(db, false);
    expect(legacy.indexOf("Hub.md")).toBeLessThan(legacy.indexOf("Bridge.md")); // cosine order
    const smooth = await order(db, true);
    expect(smooth.indexOf("Bridge.md")).toBeLessThan(smooth.indexOf("Hub.md")); // penalty order
    expect(smooth).toContain("Hub.md"); // demoted, never dropped
  });

  it("lets a strong 2-hop hit outrank a barely-gated 1-hop hit (no lexicographic hop wall)", async () => {
    const db = baseDb();
    addChunk(db, "cS", "S.md", vd(0.95));
    addChunk(db, "cMid", "Mid.md", vd(0.25)); // 1-hop, barely over the 0.2 gate
    addChunk(db, "cFar", "Far.md", vd(0.9)); // 2-hop, strong cosine (below S so S stays the seed)
    addEdge(db, "S.md", "Mid.md");
    addEdge(db, "Mid.md", "Far.md");

    const legacy = await order(db, false);
    expect(legacy.indexOf("Mid.md")).toBeLessThan(legacy.indexOf("Far.md")); // hop wall
    const smooth = await order(db, true);
    // 0.90 · 0.8^1 = 0.72 > 0.25 · 0.8^0 = 0.25 — the continuous score inverts it.
    expect(smooth.indexOf("Far.md")).toBeLessThan(smooth.indexOf("Mid.md"));
  });
});
