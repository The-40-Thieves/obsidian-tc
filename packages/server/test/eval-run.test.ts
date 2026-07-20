// Gate-verifies the eval harness core (eval/run.ts runEval) over the same deterministic
// in-memory fixture the recall gate uses: a multi-hop query whose bridge is reachable only via
// the links_to walk. Proves the harness wires baseline-vs-graph + metrics correctly without a
// live corpus or embedding backend.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeQuery, recommendV11 } from "../eval/failure_analysis";
import type { GoldenSet } from "../eval/metrics";
import { loadUndirectedGraph, reachableTargetSet } from "../eval/reachability";
import { runEval } from "../eval/run";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { floatBlob } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

const INIT = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "v1";

function vd01(c: number): number[] {
  return [c, Math.sqrt(1 - c * c), 0, 0];
}

function buildCorpus(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT }]);
  db.exec(
    `CREATE TABLE vault_edges (source_path TEXT NOT NULL, target_path TEXT NOT NULL, edge_type TEXT NOT NULL,
       edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT, vault_id TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
  );
  const addChunk = (id: string, path: string, vec: number[]): void => {
    db.prepare(
      "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, 'v1', ?, '0', '[]', ?, ?, 1, 0, 0)",
    ).run(id, path, `body ${id}`, `h-${id}`);
    db.prepare(
      "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, 'm', ?, ?, 1, 0)",
    ).run(id, vec.length, floatBlob(vec));
  };
  addChunk("cA", "A.md", vd01(0.95)); // seed
  addChunk("cB", "B.md", vd01(0.25)); // bridge: outside vector top-10, linked from A
  [0.7, 0.68, 0.66, 0.64, 0.62, 0.6, 0.58, 0.56, 0.54, 0.52, 0.5, 0.48].forEach((c, i) => {
    addChunk(`cN${i}`, `N${i}.md`, vd01(c));
  });
  db.prepare(
    "INSERT INTO vault_edges (vault_id, source_path, target_path, edge_type, provenance, created_at, updated_at) VALUES ('v1','A.md','B.md','links_to','wikilink_forward',0,0)",
  ).run();
  return db;
}

const golden: GoldenSet = {
  queries: [
    {
      id: "fx-multihop",
      query_text: "bridge query",
      seed_domain: "a",
      target_domain: "b",
      seed_paths: ["A.md"],
      target_paths: ["B.md"],
      bridge_paths: [],
      description: "B reachable only via the A->B link",
    },
  ],
};

// Fake provider: every query embeds to the seed direction [1,0,0,0].
const provider = { embed: async (texts: string[]) => texts.map(() => [1, 0, 0, 0]) };

describe("eval harness (runEval)", () => {
  it("reports graph recall >= baseline and recovers the linked bridge (no regression)", async () => {
    const report = await runEval({
      db: buildCorpus(),
      provider,
      golden,
      vaultId: VAULT,
      seedCount: 10, // B (vector rank ~14) sits outside the seeds -> only graph expansion recovers it
      router: { enabled: false }, // force expansion on the artificially-confident fixture seed
    });
    expect(report.perQuery).toHaveLength(1);
    expect(report.baselineAgg.mean_recall_at_10).toBeCloseTo(0.5);
    expect(report.graphAgg.mean_recall_at_10).toBeCloseTo(1.0);
    expect(report.recallDeltaPp).toBeGreaterThan(0);
    expect(report.noRegression).toBe(true);
  });

  it("THE-446: retainRaw surfaces per-query raw hits (with graph source) and is off by default", async () => {
    const opts = { provider, golden, vaultId: VAULT, seedCount: 10, router: { enabled: false } };
    const withRaw = await runEval({ db: buildCorpus(), ...opts, retainRaw: true });
    const q = withRaw.perQuery[0];
    expect(q?.baselineRaw).toBeDefined();
    expect(q?.treatmentRaw).toBeDefined();
    // the graph pipeline recovered B.md via expansion; the source tag is preserved for the classifier
    const bHit = q?.treatmentRaw?.find((r) => r.path === "B.md");
    expect(bHit?.source).toBe("expansion");
    // default (no retainRaw) omits the raw arrays so --json stays lean
    const lean = await runEval({ db: buildCorpus(), ...opts });
    expect(lean.perQuery[0]?.baselineRaw).toBeUndefined();
  });

  it("THE-446: --diagnose classifier + recommendV11 run end-to-end over the fixture", async () => {
    const db = buildCorpus();
    const report = await runEval({
      db,
      provider,
      golden,
      vaultId: VAULT,
      seedCount: 10,
      router: { enabled: false },
      retainRaw: true,
    });
    const q = golden.queries[0];
    const r = report.perQuery[0];
    if (!q || !r?.baselineRaw || !r.treatmentRaw) throw new Error("fixture missing raw hits");
    const graph = loadUndirectedGraph(db, VAULT);
    const reachable = reachableTargetSet(graph, q.seed_paths, q.target_paths, 4);
    expect(reachable.has("B.md")).toBe(true); // B is reachable from A via the links_to edge
    const analysis = analyzeQuery(q, r.baseline, r.graph, r.baselineRaw, r.treatmentRaw, reachable);
    expect(analysis.failure_class).toBe("success"); // graph recovers B -> the query succeeds
    const rec = recommendV11([analysis]);
    expect(rec.failures_by_class.success).toBe(1);
    expect(rec.primary_lever).toBe("none");
  });
});
