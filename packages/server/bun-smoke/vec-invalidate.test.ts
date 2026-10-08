// GH #1161: a loader that writes chunk_embeddings out-of-band (eval/load-gpu-vecs.ts) must be able
// to say "vec_chunks no longer mirrors chunk_embeddings", and the next index pass must then rebuild
// it IN FULL. Dropping the table alone used to be a silent trap: ensureVecChunks only backfilled on
// a fingerprint mismatch, so a missing table was re-created empty and filled one chunk at a time
// (390 of 16,882 rows, 2.3% dense coverage, no error). These pin both halves: the helper, and the
// missing-table backfill that makes every table-dropping caller safe.
//
// Lives in bun-smoke: the DROP+backfill branch only runs where sqlite-vec loads (see
// vec-rebuild-signal.test.ts).
import { expect, test } from "bun:test";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { buildRepresentationManifest } from "../src/search/representation";
import {
  ensureVecChunks,
  floatBlob,
  invalidateVecIndex,
  loadVec,
  type VecRebuildEvent,
} from "../src/search/vec";

const DIMS = 16;
const MODEL = "fake:model-a";
const N = 40;

const manifest = () =>
  buildRepresentationManifest({ provider: "fake", model: "model-a", dimensions: DIMS }, {});

type Db = Awaited<ReturnType<typeof openDatabase>>;

/** A provisioned db whose vec_chunks was built (empty) and whose chunk_embeddings then grew OUT OF
 *  BAND, the way the loader writes them: N active rows at MODEL, none mirrored into vec_chunks. */
async function loadedOutOfBand(): Promise<Db> {
  const db = await openDatabase(":memory:");
  provisionCacheDb(db);
  expect(ensureVecChunks(db, manifest(), { activeModel: MODEL })).toBe(true);
  const chunk = db.prepare(
    `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash,
                         token_count, created_at, updated_at)
     VALUES (?, 'v1', ?, '0', '[]', 'c', ?, 1, 0, 0)`,
  );
  const emb = db.prepare(
    `INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at)
     VALUES (?, ?, ?, ?, 1, 0)`,
  );
  for (let i = 0; i < N; i++) {
    chunk.run(`c${i}`, `c${i}.md`, `h${i}`);
    emb.run(`c${i}`, MODEL, DIMS, floatBlob(new Float32Array(DIMS).fill(i + 1)));
  }
  return db;
}

const vecRows = (db: Db): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM vec_chunks").get() as { n: number }).n;

test("without invalidation a no-change pass leaves the out-of-band rows unmirrored (the premise)", async () => {
  const db = await loadedOutOfBand();
  ensureVecChunks(db, manifest(), { activeModel: MODEL });
  expect(vecRows(db)).toBe(0);
});

test("invalidateVecIndex makes the next ensureVecChunks backfill every active embedding", async () => {
  const db = await loadedOutOfBand();
  invalidateVecIndex(db);
  const events: VecRebuildEvent[] = [];
  ensureVecChunks(db, manifest(), { activeModel: MODEL, onRebuild: (e) => events.push(e) });
  expect(vecRows(db)).toBe(N);
  expect(events).toHaveLength(1);
  expect(events[0]?.shortfall).toBeUndefined();
  // The rebuild recorded the true fingerprint again: the following pass is a no-op.
  ensureVecChunks(db, manifest(), { activeModel: MODEL, onRebuild: (e) => events.push(e) });
  expect(events).toHaveLength(1);
});

test("a dropped vec_chunks with a MATCHING fingerprint is backfilled too, not re-created empty", async () => {
  const db = await loadedOutOfBand();
  loadVec(db);
  db.exec("DROP TABLE vec_chunks"); // the old loader's whole trigger: the fingerprint row is untouched
  const events: VecRebuildEvent[] = [];
  ensureVecChunks(db, manifest(), { activeModel: MODEL, onRebuild: (e) => events.push(e) });
  expect(vecRows(db)).toBe(N);
  expect(events.map((e) => e.reason)).toEqual(["table_missing"]);
});

test("a first-ever pass over a db with nothing to mirror is not reported as a rebuild", async () => {
  const db = await openDatabase(":memory:");
  provisionCacheDb(db);
  const events: VecRebuildEvent[] = [];
  ensureVecChunks(db, manifest(), { activeModel: MODEL, onRebuild: (e) => events.push(e) });
  expect(events).toEqual([]);
  expect(vecRows(db)).toBe(0);
});

test("invalidateVecIndex is safe on a db that never built a vec index", async () => {
  const db = await openDatabase(":memory:");
  provisionCacheDb(db);
  expect(() => invalidateVecIndex(db)).not.toThrow();
});
