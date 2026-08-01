// THE-612: ensureVecChunks DROP+rebuilds vec_chunks (a full re-embed of every vault sharing the
// table) whenever the stored representation fingerprint drifts or a legacy pre-partition shape is
// detected — and used to do so with no log, no metric, no way to tell "a deploy changed the
// embedding model on purpose" from "a wrong redeploy accidentally rotated it". `onRebuild` is the
// fix: an optional, additive callback fired exactly once per DROP+rebuild.
//
// Lives in bun-smoke, like vec-model-swap.test.ts and vec-recall.test.ts's legacy-shape case: the
// DROP TABLE branch only executes where sqlite-vec actually loads. Under node:sqlite (the vitest
// runtime) `loadVec` returns false and ensureVecChunks returns before ever reaching this branch —
// a vitest test here would pass while asserting nothing.
import { expect, test } from "bun:test";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import {
  buildRepresentationManifest,
  type RepresentationManifest,
} from "../src/search/representation";
import { ensureVecChunks, floatBlob, loadVec, type VecRebuildEvent } from "../src/search/vec";

const DIMS = 16;
const PROVIDER = "fake";

/** Production shape: `provider.id`, e.g. "fake:model-old" — what chunk_embeddings.model actually
 *  stores (THE-460 fix A, review round 1). Distinct from `fp.model`, the bare name. */
const activeModelId = (model: string): string => `${PROVIDER}:${model}`;

// THE-683: ensureVecChunks now takes the full RepresentationManifest. Built by the production
// producer rather than hand-listed, so a new manifest field cannot leave this fixture stale — the
// override spread keeps every existing call site (fp({ model: ... }) etc.) working unchanged.
function fp(overrides: Partial<RepresentationManifest> = {}): RepresentationManifest {
  return {
    ...buildRepresentationManifest({ provider: PROVIDER, model: "model-a", dimensions: DIMS }, {}),
    ...overrides,
  };
}

test("does not fire onRebuild on first creation or an unchanged fingerprint", async () => {
  const db = await openDatabase(":memory:");
  provisionCacheDb(db);
  const events: VecRebuildEvent[] = [];
  const onRebuild = (e: VecRebuildEvent) => events.push(e);

  expect(ensureVecChunks(db, fp(), { onRebuild })).toBe(true); // first creation: no prior table
  expect(ensureVecChunks(db, fp(), { onRebuild })).toBe(true); // identical fingerprint: no-op
  expect(events).toEqual([]);
});

test("fires onRebuild with reason=fingerprint_changed and the skipped-vector count", async () => {
  const db = await openDatabase(":memory:");
  provisionCacheDb(db);
  expect(
    ensureVecChunks(db, fp({ model: "model-old" }), { activeModel: activeModelId("model-old") }),
  ).toBe(true);

  // One vector at the OLD model (will be skipped by the rebuild's model-filtered backfill) and
  // one that will match the NEW fingerprint's model, so skippedVectors is exactly 1, not 0 or 2.
  // Stored at the production-shaped `provider.id` (THE-460 fix A) — a bare-model row here would
  // never match the backfill predicate regardless of which model it's "for".
  const insChunk = db.prepare(
    `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash,
                         token_count, created_at, updated_at)
     VALUES (?, 'v1', ?, '0', '[]', 'c', ?, 1, 0, 0)`,
  );
  const insEmb = db.prepare(
    `INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at)
     VALUES (?, ?, ?, ?, 1, 0)`,
  );
  const vec = new Float32Array(DIMS).fill(0.1);
  insChunk.run("old-1", "old-1.md", "hash-old-1");
  insEmb.run("old-1", activeModelId("model-old"), DIMS, floatBlob(vec));
  insChunk.run("new-1", "new-1.md", "hash-new-1");
  insEmb.run("new-1", activeModelId("model-new"), DIMS, floatBlob(vec));

  const events: VecRebuildEvent[] = [];
  expect(
    ensureVecChunks(db, fp({ model: "model-new" }), {
      onRebuild: (e) => events.push(e),
      activeModel: activeModelId("model-new"),
    }),
  ).toBe(true);

  expect(events).toEqual([{ reason: "fingerprint_changed", skippedVectors: 1 }]);
});

test("fires onRebuild with reason=legacy_shape when rebuilding a pre-partition table", async () => {
  const db = await openDatabase(":memory:");
  provisionCacheDb(db);
  expect(loadVec(db)).toBe(true);
  // Hand-create the legacy (pre-partition) shape, same fixture shape as
  // vec-recall.test.ts's "THE-277: legacy vec_chunks rebuilds..." case.
  db.exec(
    `CREATE VIRTUAL TABLE vec_chunks USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[${DIMS}] distance_metric=cosine)`,
  );

  const events: VecRebuildEvent[] = [];
  expect(ensureVecChunks(db, fp(), { onRebuild: (e) => events.push(e) })).toBe(true);

  expect(events).toEqual([{ reason: "legacy_shape", skippedVectors: 0 }]);
});
