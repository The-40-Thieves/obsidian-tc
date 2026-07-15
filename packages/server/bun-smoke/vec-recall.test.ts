// Runs only under `bun test` (CI job ci-server/bun-smoke). node:sqlite (the vitest
// runtime) cannot load extensions, so this is the one place the real sqlite-vec
// vec0 path is exercised — and the gate that enforces "CI has the extension": if
// sqlite-vec fails to load on the runner, vec_enabled is false and this test fails.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { indexVault } from "../src/search/indexer";
import { semanticSearch } from "../src/search/semantic";
import { ensureVecChunks } from "../src/search/vec";

test("sqlite-vec loads under bun:sqlite and vec0 recall ranks by cosine", async () => {
  const db = await openDatabase(":memory:");
  provisionCacheDb(db);

  // The extension MUST load on this runtime — this is the CI gate.
  expect(ensureVecChunks(db, 32)).toBe(true);
  const vecTable = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'vec_chunks'").get() as
    | { x: number }
    | undefined;
  expect(vecTable?.x).toBe(1);

  const root = mkdtempSync(join(tmpdir(), "obtc-vec-"));
  writeFileSync(join(root, "fox.md"), "# Fox\n\nthe quick brown fox jumps over the lazy dog");
  writeFileSync(join(root, "weather.md"), "# Weather\n\nheavy rain and thunderstorms tonight");
  writeFileSync(join(root, "dog.md"), "# Dog\n\nthe lazy dog sleeps under the warm sun");

  const provider = fakeEmbeddingProvider({ dimensions: 32 });
  const stats = await indexVault({ db, provider, vaultId: "v", root, isReadable: () => true });
  expect(stats.vec_enabled).toBe(true); // vec0 path active, not the brute-force fallback
  expect(stats.chunks_upserted).toBe(3);

  const vecRows = db.prepare("SELECT count(*) AS c FROM vec_chunks").get() as { c: number };
  expect(vecRows.c).toBe(3);

  const [q] = await provider.embed(["lazy dog"]);
  const hits = semanticSearch(db, "v", q ?? [], { k: 3, returnContent: true });
  expect(hits.length).toBe(3);
  // notes containing "lazy dog" outrank the unrelated weather note
  expect(["fox.md", "dog.md"]).toContain(hits[0]?.path);
  expect(hits[hits.length - 1]?.path).toBe("weather.md");
  // cosine similarity is in range and descending
  expect(hits[0]?.score).toBeGreaterThan(hits[2]?.score ?? 1);

  rmSync(root, { recursive: true, force: true });
  db.close?.();
});

test("semanticSearch degrades to brute force when the query dimension mismatches vec0 (no crash)", async () => {
  const db = await openDatabase(":memory:");
  provisionCacheDb(db);
  expect(ensureVecChunks(db, 32)).toBe(true); // vec_chunks is bound to 32 dims

  const root = mkdtempSync(join(tmpdir(), "obtc-vecdim-"));
  writeFileSync(join(root, "a.md"), "# A\n\nthe quick brown fox jumps");
  const provider = fakeEmbeddingProvider({ dimensions: 32 });
  const stats = await indexVault({ db, provider, vaultId: "v", root, isReadable: () => true });
  expect(stats.vec_enabled).toBe(true);

  // Query with a DIFFERENT dimension (8) — simulates switching embedding models. sqlite-vec's
  // `embedding MATCH ?` throws on the dimension mismatch; semanticSearch must catch it and fall
  // back to the brute-force scan rather than propagating the error.
  const badDimQuery = new Array(8).fill(0.1);
  let result: ReturnType<typeof semanticSearch> | undefined;
  expect(() => {
    result = semanticSearch(db, "v", badDimQuery, { k: 3 });
  }).not.toThrow();
  expect(Array.isArray(result)).toBe(true);

  rmSync(root, { recursive: true, force: true });
  db.close?.();
});

test("THE-277: legacy vec_chunks rebuilds to the partition/aux shape from stored embeddings; KNN identical", async () => {
  const db = await openDatabase(":memory:");
  provisionCacheDb(db);
  // Hand-create the LEGACY shape (pre-partition) and seed via the authored stores. The
  // extension must be loaded on this fresh connection before any vec0 DDL.
  const { loadVec } = await import("../src/search/vec");
  expect(loadVec(db)).toBe(true);
  db.exec(
    "CREATE VIRTUAL TABLE vec_chunks USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[4] distance_metric=cosine)",
  );
  const insChunk = db.prepare(
    "INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at) VALUES (?, ?, ?, 0, '[]', 'c', ?, 1, 1, 1)",
  );
  const insEmb = db.prepare(
    "INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, generated_at) VALUES (?, 'm', 4, ?, 1)",
  );
  const insLegacy = db.prepare("INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)");
  const vecs: Record<string, number[]> = {
    a1: [1, 0, 0, 0],
    a2: [0.9, 0.1, 0, 0],
    b1: [0, 1, 0, 0],
  };
  const vaultOf: Record<string, string> = { a1: "v1", a2: "v1", b1: "v2" };
  const { floatBlob } = await import("../src/search/vec");
  for (const [id, vec] of Object.entries(vecs)) {
    insChunk.run(id, vaultOf[id], `${id}.md`, `h-${id}`);
    insEmb.run(id, floatBlob(vec));
    insLegacy.run(id, floatBlob(vec));
  }
  const q = [1, 0, 0, 0];
  const pre = db
    .prepare(
      "SELECT chunk_id, distance FROM vec_chunks WHERE embedding MATCH ? AND k = 3 ORDER BY distance",
    )
    .all(floatBlob(q)) as Array<{ chunk_id: string; distance: number }>;
  expect(pre.map((r) => r.chunk_id)).toEqual(["a1", "a2", "b1"]);

  // The rebuild: same vectors, new shape.
  expect(ensureVecChunks(db, 4)).toBe(true);
  const shaped = db.prepare("SELECT vault_id, path FROM vec_chunks LIMIT 1").get() as {
    vault_id: string;
  };
  expect(shaped.vault_id).toBeDefined();
  const count = db.prepare("SELECT count(*) AS c FROM vec_chunks").get() as { c: number };
  expect(count.c).toBe(3);

  // Partition-pruned KNN: only v1's vectors, identical distances to the legacy scan.
  const { vecKnn } = await import("../src/search/vec");
  const post = vecKnn(db, q, 3, "v1");
  expect(post.map((r) => r.chunk_id)).toEqual(["a1", "a2"]);
  expect(post[0]?.path).toBe("a1.md");
  const preByid = new Map(pre.map((r) => [r.chunk_id, r.distance]));
  for (const r of post)
    expect(Math.abs((preByid.get(r.chunk_id) ?? 99) - r.distance)).toBeLessThan(1e-6);
  // Migration recorded.
  const rec = db
    .prepare("SELECT 1 AS x FROM schema_migrations WHERE version = '20260712_004_vec_chunks_aux_4'")
    .get() as { x: number } | undefined;
  expect(rec?.x).toBe(1);
});
