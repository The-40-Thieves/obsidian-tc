// THE-460 defect: a SAME-DIMENSION model swap backfilled the OLD model's vectors.
//
// The fingerprint correctly detects the swap and triggers a rebuild. The backfill then selected
// `WHERE is_active = 1 AND length(embedding) = dims*4` with no model predicate — and old-model
// vectors of an identical dimension pass both tests. So the rebuilt index was refilled with
// vectors from the model that was just replaced, while the stored fingerprint claimed the new one.
// Retrieval then scores queries from the new model against embeddings from the old one, which is
// silently and subtly wrong rather than an error.
//
// THE-460 fix A (review round 1): the model predicate itself was ALSO wrong in a way these tests
// never caught, because they hand-seeded `chunk_embeddings.model` with the bare `fp.model`
// ("model-old") — a row shape production never writes. Every production writer
// (persist-note-plan.ts's upsertVec / chunk_embeddings insert) stores `provider.id`
// (`${provider}:${model}`, e.g. "fake:model-old"; `embeddings/index.ts`'s `withRevision` can widen
// it further to "fake:model-old@rev1"), and the backfill's bare-`fp.model` bind could therefore
// never match a real row — it silently selected ZERO rows after ANY fingerprint-triggered rebuild,
// not just a model swap. `ensureVecChunks`'s new `activeModel` opt (bound instead of `fp.model` in
// the backfill WHERE clause) fixes the predicate; these tests now seed and assert against
// production-shaped ids to actually exercise it.
//
// Lives in bun-smoke because node:sqlite cannot load sqlite-vec — this is the only runtime where
// the real vec0 rebuild path executes.
import { expect, test } from "bun:test";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import {
  buildRepresentationManifest,
  type RepresentationManifest,
} from "../src/search/representation";
import { ensureVecChunks, floatBlob } from "../src/search/vec";

const DIMS = 32;
const PROVIDER = "fake";

/** Production shape: `provider.id`, e.g. "fake:model-old" — what chunk_embeddings.model /
 *  vec_chunks.model actually store. Distinct from `fp.model`, the bare name folded into the
 *  canonical fingerprint string. */
const activeModelId = (model: string): string => `${PROVIDER}:${model}`;

// THE-683: ensureVecChunks now takes the full RepresentationManifest. Built by the production
// producer rather than hand-listed, so a new manifest field cannot leave this fixture stale — the
// override spread keeps every existing call site (fp({ model: ... }) etc.) working unchanged.
function fp(overrides: Partial<RepresentationManifest> = {}): RepresentationManifest {
  return {
    ...buildRepresentationManifest(
      { provider: PROVIDER, model: "model-old", dimensions: DIMS },
      {},
    ),
    ...overrides,
  };
}

/** Seed one chunk + one active embedding attributed to `storedModel` — pass a `provider.id`-shaped
 *  value (activeModelId(...)) to match what production actually writes. */
function seed(db: Awaited<ReturnType<typeof openDatabase>>, id: string, storedModel: string): void {
  db.prepare(
    `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash,
                         token_count, created_at, updated_at)
     VALUES (?, 'v1', ?, '0', '[]', ?, ?, 1, 0, 0)`,
  ).run(id, `${id}.md`, id, `hash-${id}`);
  const vec = new Float32Array(DIMS).fill(0.1);
  db.prepare(
    `INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at)
     VALUES (?, ?, ?, ?, 1, 0)`,
  ).run(id, storedModel, DIMS, floatBlob(vec));
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

  expect(ensureVecChunks(db, fp(), { activeModel: activeModelId("model-old") })).toBe(true);

  // Two active embeddings at the SAME dimensionality, from different models, stored at the
  // production-shaped identity — the exact shape the length-only filter cannot distinguish.
  seed(db, "old-1", activeModelId("model-old"));
  seed(db, "new-1", activeModelId("model-new"));

  // Swap the model. Same dims, so the fingerprint changes but every byte length still matches.
  expect(
    ensureVecChunks(db, fp({ model: "model-new" }), { activeModel: activeModelId("model-new") }),
  ).toBe(true);

  expect(indexedModels(db)).toEqual([activeModelId("model-new")]);
});

test("the rebuild still backfills vectors that DO match the current model", async () => {
  const db = await openDatabase(":memory:");
  provisionCacheDb(db);
  expect(ensureVecChunks(db, fp(), { activeModel: activeModelId("model-old") })).toBe(true);

  seed(db, "a", activeModelId("model-old"));
  seed(db, "b", activeModelId("model-old"));

  // A non-model fingerprint field changes: same model, so both vectors must survive the rebuild.
  expect(
    ensureVecChunks(db, fp({ enrichmentVersion: 1 }), { activeModel: activeModelId("model-old") }),
  ).toBe(true);

  const n = db.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n: number };
  expect(n.n).toBe(2);
  expect(indexedModels(db)).toEqual([activeModelId("model-old")]);
});

// THE-460 fix A regression test (review round 1): dedicated coverage for the exact defect the
// reviewer measured — a fingerprint-triggered rebuild UNRELATED to the model (no model/revision
// change at all) dropped every production-shaped vector because the backfill bound the bare
// `fp.model` against a column that stores `provider.id`. This must FAIL against the pre-fix
// predicate (binding `fp.model` unconditionally): "fake:model-a" (stored) never equals "model-a"
// (fp.model), so the old code backfills zero rows here regardless of `activeModel`.
test("fix A: a rebuild unrelated to the model preserves production-shaped (provider.id) vectors", async () => {
  const db = await openDatabase(":memory:");
  provisionCacheDb(db);
  const idA = activeModelId("model-a");
  expect(ensureVecChunks(db, fp({ model: "model-a" }), { activeModel: idA })).toBe(true);

  seed(db, "p1", idA);
  seed(db, "p2", idA);
  seed(db, "p3", idA);

  // schemaGen bump: a representation change with nothing to do with the model at all.
  expect(ensureVecChunks(db, fp({ model: "model-a", schemaGen: "v2" }), { activeModel: idA })).toBe(
    true,
  );

  const n = db.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n: number };
  expect(n.n).toBe(3); // backfill count > 0 (all 3 preserved) — the Critical's assertion.
  expect(indexedModels(db)).toEqual([idA]);
});
