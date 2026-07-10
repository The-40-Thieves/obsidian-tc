// THE-388 encode->store — the indexer writes chunk_sparse + chunk_colbert when the provider emits
// embedFull() (bge-m3), and leaves them unprovisioned for a dense-only provider. Exercised with a
// fake multi-representation provider; the real bge-m3 encoder (ONNX/vLLM) is infra-gated.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrate";
import type { Database } from "../src/db/types";
import type { EmbeddingProvider, MultiVectorEmbedding } from "../src/embeddings/provider";
import { indexNote } from "../src/search/indexer";
import { openMemoryDb } from "./helpers";

const INIT_SQL = readFileSync(
  fileURLToPath(new URL("../src/migrations/20260519_001_initial.sql", import.meta.url)),
  "utf8",
);
const VAULT = "v1";

function db0(): Database {
  const db = openMemoryDb();
  runMigrations(db, [{ version: "20260519_001", sql: INIT_SQL }]);
  return db;
}

function tableExists(db: Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined
  );
}

const denseOnly: EmbeddingProvider = {
  id: "fake:dense",
  provider: "fake",
  model: "d",
  dimensions: 4,
  async embed(texts) {
    return texts.map(() => [1, 0, 0, 0]);
  },
};

const multiRep: EmbeddingProvider = {
  id: "fake:bge-m3",
  provider: "bge-m3",
  model: "m",
  dimensions: 4,
  async embed(texts) {
    return texts.map(() => [1, 0, 0, 0]);
  },
  async embedFull(texts): Promise<MultiVectorEmbedding[]> {
    return texts.map(() => ({
      dense: [1, 0, 0, 0],
      sparse: { tok_a: 0.9, tok_b: 0.3 },
      colbert: [
        [1, 0],
        [0, 1],
      ],
    }));
  },
};

describe("encode->store wiring (THE-388)", () => {
  it("writes chunk_sparse + chunk_colbert when the provider emits embedFull", async () => {
    const db = db0();
    const r = await indexNote(
      db,
      multiRep,
      VAULT,
      "A.md",
      "Alpha content about obsidian retrieval and ranking.",
      false,
      () => 0,
    );
    expect(r.upserted).toBeGreaterThan(0);
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    const chunks = n("SELECT COUNT(*) AS n FROM chunks");
    expect(n("SELECT COUNT(*) AS n FROM chunk_sparse")).toBe(chunks);
    expect(n("SELECT COUNT(*) AS n FROM chunk_colbert")).toBe(chunks);
    const s = db.prepare("SELECT weights FROM chunk_sparse LIMIT 1").get() as { weights: string };
    expect(JSON.parse(s.weights)).toEqual({ tok_a: 0.9, tok_b: 0.3 });
    const c = db.prepare("SELECT vectors FROM chunk_colbert LIMIT 1").get() as { vectors: string };
    expect(JSON.parse(c.vectors)).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it("dense-only provider leaves chunk_sparse / chunk_colbert unprovisioned", async () => {
    const db = db0();
    const r = await indexNote(
      db,
      denseOnly,
      VAULT,
      "A.md",
      "Alpha content about obsidian retrieval.",
      false,
      () => 0,
    );
    expect(r.upserted).toBeGreaterThan(0);
    expect(tableExists(db, "chunk_sparse")).toBe(false);
    expect(tableExists(db, "chunk_colbert")).toBe(false);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM chunk_embeddings").get() as { n: number }).n,
    ).toBeGreaterThan(0);
  });
});
