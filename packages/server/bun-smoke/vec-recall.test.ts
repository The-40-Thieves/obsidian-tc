// Runs only under `bun test` (CI job ci-server/bun-smoke). node:sqlite (the vitest
// runtime) cannot load extensions, so this is the one place the real sqlite-vec
// vec0 path is exercised — and the gate that enforces "CI has the extension": if
// sqlite-vec fails to load on the runner, vec_enabled is false and this test fails.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db/open";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { indexVault } from "../src/search/indexer";
import { semanticSearch } from "../src/search/semantic";
import { ensureVecChunks } from "../src/search/vec";

const schemaSql = readFileSync(
  fileURLToPath(new URL("../src/schema.sql", import.meta.url)),
  "utf8",
);

test("sqlite-vec loads under bun:sqlite and vec0 recall ranks by cosine", async () => {
  const db = await openDatabase(":memory:");
  db.exec(schemaSql);

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
  db.exec(schemaSql);
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
