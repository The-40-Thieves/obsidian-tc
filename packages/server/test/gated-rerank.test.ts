// THE-394 — gated cross-encoder rerank. Proves: (1) an easy query (confident top-1 seed) never
// pays the reranker call, (2) a hard query reranks the head of the fused list and keeps the
// remainder in RRF order below, (3) disabled / absent reranker preserves pure RRF behavior.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import { graphSearch } from "../src/search/graph_search";
import type { Reranker, RerankOutcome } from "../src/search/rerank";
import { floatBlob } from "../src/search/vec";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "v1";

function vd(c: number): number[] {
  return [c, Math.sqrt(1 - c * c), 0, 0];
}

function seedDb(): Database {
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

function addChunk(db: Database, id: string, path: string, content: string, vec: number[]): void {
  db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, VAULT, path, "0", "[]", content, `h-${id}`, 1, 0, 0);
  db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at) VALUES (?, ?, ?, ?, 1, 0)",
  ).run(id, "test:embed", vec.length, floatBlob(vec));
}

function spyReranker(): { reranker: Reranker; calls: Array<{ query: string; docs: string[] }> } {
  const calls: Array<{ query: string; docs: string[] }> = [];
  const reranker: Reranker = async (query, documents) => {
    calls.push({ query, docs: documents });
    // Reverse the incoming order with descending scores.
    return documents.map((_, i) => ({
      index: documents.length - 1 - i,
      relevanceScore: 1 - i * 0.1,
    }));
  };
  return { reranker, calls };
}

const BASE = {
  query: "anything at all",
  queryVec: [1, 0, 0, 0],
  vaultId: VAULT,
  finalTopK: 10,
  router: { enabled: false as const },
  lexical: { enabled: false as const },
};

function hardDb(): Database {
  const db = seedDb();
  addChunk(db, "a", "A.md", "alpha content", vd(0.4)); // top-1 = 0.4 < 0.55 -> hard
  addChunk(db, "b", "B.md", "beta content", vd(0.35));
  addChunk(db, "c", "C.md", "gamma content", vd(0.3));
  return db;
}

function outcomeSpy(): { outcomes: RerankOutcome[]; onRerankOutcome: (o: RerankOutcome) => void } {
  const outcomes: RerankOutcome[] = [];
  return { outcomes, onRerankOutcome: (o) => outcomes.push(o) };
}

describe("THE-394 gated rerank", () => {
  it("an easy query (confident top-1) never calls the reranker", async () => {
    const db = seedDb();
    addChunk(db, "a", "A.md", "alpha content", vd(0.99)); // top-1 well above the gate
    addChunk(db, "b", "B.md", "beta content", vd(0.4));
    const { reranker, calls } = spyReranker();
    const { outcomes, onRerankOutcome } = outcomeSpy();
    const out = await graphSearch(db, {
      ...BASE,
      seedCount: 2,
      reranker,
      gatedRerank: { enabled: true },
      onRerankOutcome,
    });
    expect(calls).toHaveLength(0);
    expect(out.map((r) => r.chunk_id)).toEqual(["a", "b"]);
    // a reranker IS configured and the gate IS on, but this query didn't qualify as
    // hard — a deliberate policy decision, reported distinctly from "not configured" below.
    expect(outcomes).toEqual(["skipped_by_policy"]);
  });

  it("a hard query reranks the head and keeps the remainder in RRF order", async () => {
    const db = hardDb();
    const { reranker, calls } = spyReranker();
    const { outcomes, onRerankOutcome } = outcomeSpy();
    const out = await graphSearch(db, {
      ...BASE,
      seedCount: 3,
      reranker,
      gatedRerank: { enabled: true, pool: 2 }, // rerank only the top-2; c stays below
      onRerankOutcome,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.docs).toEqual(["alpha content", "beta content"]);
    // Spy reverses the head: b above a; c untouched below.
    expect(out.map((r) => r.chunk_id)).toEqual(["b", "a", "c"]);
    // crux: the gate fired and the reranker actually ran — "executed", never confusable
    // with the "skipped_by_policy"/"not_configured" cases above/below despite an identical-shaped
    // GraphSearchResult[] coming back from all three.
    expect(outcomes).toEqual(["executed"]);
  });

  it("disabled gate and absent reranker both preserve pure RRF order", async () => {
    const db = hardDb();
    const { reranker, calls } = spyReranker();
    const { outcomes, onRerankOutcome } = outcomeSpy();
    const disabled = await graphSearch(db, { ...BASE, seedCount: 3, reranker, onRerankOutcome });
    expect(calls).toHaveLength(0);
    expect(disabled.map((r) => r.chunk_id)).toEqual(["a", "b", "c"]);
    // The feature itself is off (static config, not a runtime decision) — no rerank decision was
    // made at all, so nothing is reported; distinct from the two cases below where a reranker
    // decision point was reached but resolved differently.
    expect(outcomes).toEqual([]);

    const noBackend = await graphSearch(db, {
      ...BASE,
      seedCount: 3,
      gatedRerank: { enabled: true },
      onRerankOutcome,
    });
    expect(noBackend.map((r) => r.chunk_id)).toEqual(["a", "b", "c"]);
    // crux (the other half): the gate is ON but no reranker was ever injected — distinct
    // from "skipped_by_policy" above, where a reranker exists and the gate legitimately passed on
    // it, and distinct from "executed", where one ran.
    expect(outcomes).toEqual(["not_configured"]);
  });
});
