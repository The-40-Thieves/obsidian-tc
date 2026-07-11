// THE-400 — z-margin confidence signal. Pins: (1) the statistic itself; (2) router z-mode
// (zThreshold replaces the sim/margin rule: high threshold -> expansion runs, low -> bypassed);
// (3) gated-rerank hardZ (z-mode hardness decides whether the reranker fires at all).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { graphSearch, seedZMargin } from "../src/search/graph_search";
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

// S (strong seed) links to B (expansion-only reachable). Seed pool = {S: .95, N: .6} gives an
// exact two-point z-margin of 1.0 for threshold pins on either side.
function corpus(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  db.exec(
    `CREATE TABLE vault_edges (
       source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
       edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT, vault_id TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
     );`,
  );
  addChunk(db, "cS", "S.md", vd(0.95));
  addChunk(db, "cN", "N.md", vd(0.6));
  addChunk(db, "cB", "B.md", vd(0.3)); // outside seedCount=2, reachable only via S's link
  db.prepare(
    "INSERT INTO vault_edges (vault_id, source_path, target_path, edge_type, provenance, created_at, updated_at) VALUES (?, 'S.md', 'B.md', 'links_to', 'wikilink', 0, 0)",
  ).run(VAULT);
  return db;
}

describe("THE-400 seedZMargin", () => {
  it("computes (top1 - mean) / population sd", () => {
    // scores [0.9, 0.5, 0.5, 0.5]: mean .6, sd sqrt(.03) -> z = .3/.1732 = 1.732
    expect(seedZMargin([0.9, 0.5, 0.5, 0.5])).toBeCloseTo(1.732, 3);
    expect(seedZMargin([0.95, 0.6])).toBeCloseTo(1.0, 6);
  });

  it("degenerates to 0 without signal (empty, single, constant)", () => {
    expect(seedZMargin([])).toBe(0);
    expect(seedZMargin([0.9])).toBe(0);
    expect(seedZMargin([0.5, 0.5, 0.5])).toBe(0);
  });
});

describe("THE-400 router z-mode", () => {
  it("bypasses expansion when z >= threshold and engages it when z < threshold", async () => {
    const db = corpus();
    const run = (zThreshold: number) =>
      graphSearch(db, {
        query: "fixture",
        queryVec: QUERY_VEC,
        vaultId: VAULT,
        seedCount: 2,
        finalTopK: 10,
        router: { enabled: true, zThreshold },
      });
    // z = 1.0 exactly: threshold 0.5 -> routed (confident lock), no expansion source.
    const routed = await run(0.5);
    expect(routed.some((r) => r.source === "expansion")).toBe(false);
    // threshold 1.5 -> not routed, B.md arrives via expansion.
    const engaged = await run(1.5);
    expect(engaged.some((r) => r.source === "expansion" && r.path === "B.md")).toBe(true);
  });
});

describe("THE-400 gated-rerank hardZ", () => {
  const runGated = async (db: Database, hardZ: number, calls: string[]) =>
    graphSearch(db, {
      query: "fixture",
      queryVec: QUERY_VEC,
      vaultId: VAULT,
      seedCount: 2,
      finalTopK: 10,
      router: { enabled: false },
      gatedRerank: { enabled: true, hardZ },
      reranker: async (_query, documents) => {
        calls.push(...documents);
        return documents.map((_, index) => ({ index, relevanceScore: 1 }));
      },
    });

  it("fires the reranker only when the z-margin marks the query hard", async () => {
    const db = corpus();
    const notHard: string[] = [];
    await runGated(db, -999, notHard); // z(1.0) >= -999 -> easy -> reranker never called
    expect(notHard).toHaveLength(0);
    const hard: string[] = [];
    await runGated(db, 999, hard); // z(1.0) < 999 -> hard -> reranker called on the head
    expect(hard.length).toBeGreaterThan(0);
  });
});
