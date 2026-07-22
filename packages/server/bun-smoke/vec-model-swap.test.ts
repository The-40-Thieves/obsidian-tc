// THE-460 defect: a SAME-DIMENSION model swap backfilled the OLD model's vectors.
//
// The fingerprint correctly detects the swap and triggers a rebuild. The backfill then selected
// `WHERE is_active = 1 AND length(embedding) = dims*4` with no model predicate — and old-model
// vectors of an identical dimension pass both tests. So the rebuilt index was refilled with
// vectors from the model that was just replaced, while the stored fingerprint claimed the new one.
// Retrieval then scores queries from the new model against embeddings from the old one, which is
// silently and subtly wrong rather than an error.
//
// Lives in bun-smoke because node:sqlite cannot load sqlite-vec — this is the only runtime where
// the real vec0 rebuild path executes.
import { expect, test } from "bun:test";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import {
  CHUNKER_VERSION,
  VEC_DISTANCE_METRIC,
  VEC_SCHEMA_GEN,
  type VecFingerprint,
} from "../src/search/representation";
import { ensureVecChunks, floatBlob } from "../src/search/vec";

const DIMS = 32;

function fp(overrides: Partial<VecFingerprint> = {}): VecFingerprint {
  return {
    provider: "fake",
    model: "model-old",
    dimensions: DIMS,
    distanceMetric: VEC_DISTANCE_METRIC,
    enrichmentVersion: 0,
    chunkerVersion: CHUNKER_VERSION,
    schemaGen: VEC_SCHEMA_GEN,
    ...overrides,
  };
}

/** Seed one chunk + one active embedding attributed to `model`. */
function seed(db: Awaited<ReturnType<typeof openDatabase>>, id: string, model: string): void {
  db.prepare(
    `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash,
                         token_count, created_at, updated_at)
     VALUES (?, 'v1', ?, '0', '[]', ?, ?, 1, 0, 0)`,
  ).run(id, `${id}.md`, id, `hash-${id}`);
  const vec = new Float32Array(DIMS).fill(0.1);
  db.prepare(
    `INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at)
     VALUES (?, ?, ?, ?, 1, 0)`,
  ).run(id, model, DIMS, floatBlob(vec));
}

function indexedModels(db: Awaited<ReturnType<typeof openDatabase>>): string[] {
  const rows = db.prepare("SELECT DISTINCT model FROM vec_chunks ORDER BY model").all() as {
    model: string;
  }[];
  return rows.map((r) => r.model);
}

test("a same-dimension model swap does not backfill the old model's vectors", async () => {
  const db = await openDatabase(":memory:");
  provisionCacheDb(db);

  expect(ensureVecChunks(db, fp())).toBe(true);

  // Two active embeddings at the SAME dimensionality, from different models — the exact shape the
  // length-only filter cannot distinguish.
  seed(db, "old-1", "model-old");
  seed(db, "new-1", "model-new");

  // Swap the model. Same dims, so the fingerprint changes but every byte length still matches.
  expect(ensureVecChunks(db, fp({ model: "model-new" }))).toBe(true);

  expect(indexedModels(db)).toEqual(["model-new"]);
});

test("the rebuild still backfills vectors that DO match the current model", async () => {
  const db = await openDatabase(":memory:");
  provisionCacheDb(db);
  expect(ensureVecChunks(db, fp())).toBe(true);

  seed(db, "a", "model-old");
  seed(db, "b", "model-old");

  // A non-model fingerprint field changes: same model, so both vectors must survive the rebuild.
  expect(ensureVecChunks(db, fp({ enrichmentVersion: 1 }))).toBe(true);

  const n = db.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n: number };
  expect(n.n).toBe(2);
  expect(indexedModels(db)).toEqual(["model-old"]);
});
