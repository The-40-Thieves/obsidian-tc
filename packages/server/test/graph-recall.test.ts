// THE-233 W-RETRIEVAL eval gate (deterministic fixture).
//
// Proves the no-regression property NOW, without a live corpus or embeddings (no model is
// pulled locally; the vault is 921 notes): a controlled in-memory corpus + the REAL
// retrieval code (semanticSearch baseline vs graphSearch) + the ported eval metrics. The
// live golden-set run (multi-hop-golden-set.yaml + baseline.json over an indexed vault) is
// gated on a settled embedding provider / Slice-5 export — see eval/metrics.ts.
//
// Scenario: a multi-hop query whose bridge note B is semantically far from the query
// (cosine 0.25, outside the vector top-k) but reachable via a wikilink from the top seed A.
// Vector-only retrieval misses B; the links_to graph walk surfaces it. A single-hop control
// query confirms graph augmentation never regresses the direct-retrieval case.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  aggregateMetrics,
  computeQueryMetrics,
  type GoldenQuery,
  type RankedChunk,
} from "../eval/metrics";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { graphSearch } from "../src/search/graph_search";
import { semanticSearch } from "../src/search/semantic";
import { floatBlob } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "v1";

// Unit vector with the given cosine to [1,0,0,0] (dims 0/1) or to [0,0,1,0] (dims 2/3).
function vecDim01(cos: number): number[] {
  return [cos, Math.sqrt(1 - cos * cos), 0, 0];
}
function vecDim23(cos: number): number[] {
  return [0, 0, cos, Math.sqrt(1 - cos * cos)];
}

function addChunk(db: Database, id: string, path: string, vec: number[]): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, VAULT, path, "0", "[]", `body ${id}`, `h-${id}`, 1, 0, 0);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, 0)",
  ).run(id, "test:embed", vec.length, floatBlob(vec));
}

function addEdge(db: Database, source: string, target: string, provenance: string): void {
  db.prepare(
    "INSERT INTO vault_edges (vault_id, source_path, target_path, edge_type, provenance, created_at, updated_at) VALUES (?, ?, ?, 'links_to', ?, 0, 0)",
  ).run(VAULT, source, target, provenance);
}

function buildCorpus(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  db.exec(
    `CREATE TABLE vault_edges (
       source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
       edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT, vault_id TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
     );`,
  );

  // Multi-hop fixture (query1 = [1,0,0,0]).
  addChunk(db, "cA", "A.md", vecDim01(0.95)); // top seed
  addChunk(db, "cB", "B.md", vecDim01(0.25)); // bridge: outside vector top-k, linked from A
  const noiseCos = [0.7, 0.68, 0.66, 0.64, 0.62, 0.6, 0.58, 0.56, 0.54, 0.52, 0.5, 0.48];
  noiseCos.forEach((c, i) => {
    addChunk(db, `cN${i}`, `N${i}.md`, vecDim01(c));
  });
  addEdge(db, "A.md", "B.md", "wikilink_forward");
  addEdge(db, "B.md", "A.md", "wikilink_reverse");

  // Single-hop control (query2 = [0,0,1,0]): D is the direct, unlinked answer.
  addChunk(db, "cD", "D.md", vecDim23(0.99));
  return db;
}

function baselineAdapter(db: Database, queryVec: number[]): RankedChunk[] {
  return semanticSearch(db, VAULT, queryVec, { k: 10 }).map((h) => ({
    chunk_id: h.chunk_id,
    path: h.path,
  }));
}

async function graphAdapter(
  db: Database,
  query: string,
  queryVec: number[],
): Promise<RankedChunk[]> {
  // Router off so the expansion mechanism is exercised on the multi-hop case; rerank is the
  // default graph_rrf path (no model call), so no gateway is needed in this unit.
  const results = await graphSearch(db, {
    query,
    queryVec,
    vaultId: VAULT,
    seedCount: 10,
    finalTopK: 10,
    router: { enabled: false },
  });
  return results.map((r) => ({
    chunk_id: r.chunk_id,
    path: r.path,
    source: r.source,
    hop: r.hop,
  }));
}

const Q_MULTIHOP: GoldenQuery = {
  id: "fx-multihop",
  query_text: "multi-hop bridge",
  seed_domain: "a",
  target_domain: "b",
  seed_paths: ["A.md"],
  target_paths: ["B.md"],
  bridge_paths: [],
  description: "B is reachable only via the A->B wikilink, not by vector similarity.",
};
const Q_SINGLEHOP: GoldenQuery = {
  id: "fx-singlehop",
  query_text: "direct lookup",
  seed_domain: "d",
  target_domain: "d",
  seed_paths: ["D.md"],
  target_paths: ["D.md"],
  bridge_paths: [],
  description: "Direct vector hit; graph augmentation must not regress it.",
};

describe("W-RETRIEVAL eval gate: graph + rerank do not regress recall", () => {
  it("multi-hop: vector-only misses the linked bridge; graph expansion recovers it", async () => {
    const db = buildCorpus();
    const q1 = [1, 0, 0, 0];
    const base = computeQueryMetrics(Q_MULTIHOP, baselineAdapter(db, q1));
    const graph = computeQueryMetrics(Q_MULTIHOP, await graphAdapter(db, "multi-hop bridge", q1));

    // Baseline finds the seed but not the bridge; graph finds both.
    expect(base.recall_at_10).toBeCloseTo(0.5);
    expect(base.bridge_recall).toBe(0);
    expect(graph.recall_at_10).toBeCloseTo(1.0);
    expect(graph.bridge_recall).toBe(1);
    expect(graph.recall_at_10).toBeGreaterThan(base.recall_at_10);
  });

  it("single-hop: graph augmentation does not regress the direct case", async () => {
    const db = buildCorpus();
    const q2 = [0, 0, 1, 0];
    const base = computeQueryMetrics(Q_SINGLEHOP, baselineAdapter(db, q2));
    const graph = computeQueryMetrics(Q_SINGLEHOP, await graphAdapter(db, "direct lookup", q2));
    expect(base.recall_at_10).toBeCloseTo(1.0);
    expect(graph.recall_at_10).toBeGreaterThanOrEqual(base.recall_at_10);
  });

  it("aggregate gate: mean recall@10 and bridge-recall rate do not regress (and improve)", async () => {
    const db = buildCorpus();
    const q1 = [1, 0, 0, 0];
    const q2 = [0, 0, 1, 0];
    const baseAgg = aggregateMetrics([
      computeQueryMetrics(Q_MULTIHOP, baselineAdapter(db, q1)),
      computeQueryMetrics(Q_SINGLEHOP, baselineAdapter(db, q2)),
    ]);
    const graphAgg = aggregateMetrics([
      computeQueryMetrics(Q_MULTIHOP, await graphAdapter(db, "multi-hop bridge", q1)),
      computeQueryMetrics(Q_SINGLEHOP, await graphAdapter(db, "direct lookup", q2)),
    ]);
    expect(graphAgg.mean_recall_at_10).toBeGreaterThanOrEqual(baseAgg.mean_recall_at_10); // gate
    expect(graphAgg.mean_recall_at_10).toBeGreaterThan(baseAgg.mean_recall_at_10); // improvement
    expect(graphAgg.bridge_recall_rate).toBeGreaterThan(baseAgg.bridge_recall_rate);
  });
});
