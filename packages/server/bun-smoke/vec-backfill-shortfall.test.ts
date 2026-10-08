// GH #1160: ensureVecChunks' backfill used to report a rebuild that put 0 of N active embeddings in
// the dense index exactly like a healthy one. These pin the loud path: a stderr WARNING naming the
// counts and where the active rows actually are, and `shortfall` on the onRebuild event.
//
// Lives in bun-smoke for the same reason as vec-rebuild-signal.test.ts: the DROP+backfill branch
// only executes where sqlite-vec loads, which node:sqlite (the vitest runtime) cannot do.
import { afterEach, expect, spyOn, test } from "bun:test";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { buildRepresentationManifest } from "../src/search/representation";
import { ensureVecChunks, floatBlob, type VecRebuildEvent } from "../src/search/vec";

const DIMS = 16;
const MODEL = "fake:model-a";

const manifest = () =>
  buildRepresentationManifest({ provider: "fake", model: "model-a", dimensions: DIMS }, {});

function seed(db: Awaited<ReturnType<typeof openDatabase>>) {
  const chunk = db.prepare(
    `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash,
                         token_count, created_at, updated_at)
     VALUES (?, 'v1', ?, '0', '[]', 'c', ?, 1, 0, 0)`,
  );
  const emb = db.prepare(
    `INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at)
     VALUES (?, ?, ?, ?, ?, 0)`,
  );
  return {
    chunk: (id: string) => chunk.run(id, `${id}.md`, `h-${id}`),
    emb: (id: string, model: string, width: number, active: 0 | 1 = 1) =>
      emb.run(id, model, width, floatBlob(new Float32Array(width).fill(0.1)), active),
  };
}

let stderr: ReturnType<typeof spyOn> | undefined;
afterEach(() => stderr?.mockRestore());
const captureStderr = (): (() => string) => {
  const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
  stderr = spy;
  return () => spy.mock.calls.map((c) => String(c[0])).join("");
};

test("warns loudly when every active embedding is at another width/model (the issue's 0-row rebuild)", async () => {
  const db = await openDatabase(":memory:");
  provisionCacheDb(db);
  ensureVecChunks(db, manifest(), { activeModel: MODEL });
  const s = seed(db);
  for (const id of ["c1", "c2", "c3"]) {
    s.chunk(id);
    s.emb(id, "other:model", 8); // a stale 8-wide model, active, none at the configured 16-wide model
  }
  const logged = captureStderr();
  const events: VecRebuildEvent[] = [];
  // Force a rebuild by changing a fingerprint axis (a different model name).
  ensureVecChunks(
    db,
    buildRepresentationManifest({ provider: "fake", model: "model-b", dimensions: DIMS }, {}),
    { activeModel: "fake:model-b", onRebuild: (e) => events.push(e) },
  );
  const text = logged();
  expect(text).toContain("[vec] WARNING: vec_chunks was rebuilt with 0 of 3 active embedding(s)");
  expect(text).toContain("other:model @ 8: 3");
  expect(text).toContain("another width/model");
  expect(events).toHaveLength(1);
  expect(events[0]?.shortfall).toEqual({
    active: 3,
    inserted: 0,
    multiActiveChunks: 0,
    breakdown: ["other:model @ 8: 3"],
  });
  expect(events[0]?.skippedVectors).toBe(3);
});

test("names a chunk carrying more than one active embedding as the likely cause", async () => {
  const db = await openDatabase(":memory:");
  provisionCacheDb(db);
  ensureVecChunks(db, manifest(), { activeModel: MODEL });
  // A pre-#1160 store: the old non-unique index permits the violation the new one forbids.
  db.exec("DROP INDEX idx_chunk_embeddings_active");
  const s = seed(db);
  s.chunk("c1");
  s.emb("c1", MODEL, DIMS); // correct width, backfills
  s.emb("c1", "other:model", 8); // the stale second active row
  const logged = captureStderr();
  const events: VecRebuildEvent[] = [];
  ensureVecChunks(
    db,
    buildRepresentationManifest({ provider: "fake", model: "model-a2", dimensions: DIMS }, {}),
    { activeModel: MODEL, onRebuild: (e) => events.push(e) },
  );
  expect(logged()).toContain("1 chunk(s) carry MORE THAN ONE active embedding");
  expect(events[0]?.shortfall?.multiActiveChunks).toBe(1);
});

test("a healthy rebuild stays a plain rebuild: no warning, no shortfall on the event", async () => {
  const db = await openDatabase(":memory:");
  provisionCacheDb(db);
  ensureVecChunks(db, manifest(), { activeModel: MODEL });
  const s = seed(db);
  for (const id of ["c1", "c2"]) {
    s.chunk(id);
    s.emb(id, "fake:model-b", DIMS);
  }
  const logged = captureStderr();
  const events: VecRebuildEvent[] = [];
  ensureVecChunks(
    db,
    buildRepresentationManifest({ provider: "fake", model: "model-b", dimensions: DIMS }, {}),
    { activeModel: "fake:model-b", onRebuild: (e) => events.push(e) },
  );
  expect(logged()).not.toContain("WARNING");
  expect(events).toEqual([{ reason: "fingerprint_changed", skippedVectors: 0 }]);
});
