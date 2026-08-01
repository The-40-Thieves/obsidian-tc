// THE-460 review round 1, the Critical: the reviewer measured setting embeddings.revision DROPS
// vec_chunks and refills nothing — dense hits go from >0 to 0, stay 0 after a further reconcile,
// and stay 0 even after removing the setting again. Root cause was two-fold:
//   A. ensureVecChunks's backfill bound the bare `fp.model` against a column
//      (chunk_embeddings.model / vec_chunks.model) that actually stores `provider.id`
//      ("ollama:bge-m3", not "bge-m3") — so the backfill matched ZERO rows after ANY
//      fingerprint-triggered rebuild, not only a revision change. This was masked for every OTHER
//      fingerprint field because changing it also changes provider.id or content_hash, which
//      forces a re-embed that refills the table through live upsertVec calls instead.
//   B. `revision` was the first operator-settable field that moves the fingerprint while leaving
//      BOTH provider.id and content_hash untouched — so neither the (broken) backfill nor the
//      re-embed gate ever refilled the table, and it stayed empty forever.
//
// Fix A gives ensureVecChunks an `activeModel` opt (bound in the backfill instead of `fp.model`).
// Fix B makes createEmbeddingProvider suffix `provider.id` with `@<revision>` when one is declared
// (embeddings/index.ts's withRevision — see test/provider-revision-identity.test.ts for the direct
// unit test of that wrapper), so a revision bump changes the identity the re-embed gate compares.
//
// Review round 2 (Important): the round-1 version of this test built its providers by HAND
// (fakeEmbeddingProvider + a manual `@revision` suffix), so its assertions passed unconditionally
// regardless of whether createEmbeddingProvider's withRevision wrapper (fix B) actually worked —
// reverting fix B in production left this whole test green. Fixed by routing through the REAL
// createEmbeddingProvider (production's factory, `testProvider` below) so a fix-B regression
// changes what gets stored; only `.embed` is replaced with a fast deterministic function (the same
// one fakeEmbeddingProvider itself uses) so indexing needs no reachable ollama server.
//
// This test reproduces the reviewer's exact probe against indexVault with a real vec0 table (lives
// in bun-smoke: node:sqlite cannot load sqlite-vec, so this is the only runtime the real DROP+
// backfill path executes).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import type { EmbeddingProvider, EmbeddingsConfigLike } from "../src/embeddings";
import { createEmbeddingProvider, deterministicVector } from "../src/embeddings";
import { indexVault } from "../src/search/indexer";
import { semanticSearch } from "../src/search/semantic";

const DIMS = 32;

/** Routes through the REAL createEmbeddingProvider — including fix B's withRevision wrapper — so
 *  `.id` is exactly what production computes from `cfg`. Only `.embed` (the network-calling part)
 *  is replaced with a deterministic local function; `.id`/`.provider`/`.model`/`.dimensions` are
 *  untouched, so a fix-B regression is visible in what gets stored. */
function testProvider(cfg: EmbeddingsConfigLike): EmbeddingProvider {
  const real = createEmbeddingProvider(cfg);
  return {
    id: real.id,
    provider: real.provider,
    model: real.model,
    dimensions: real.dimensions,
    embed: (texts: string[]) =>
      Promise.resolve(texts.map((t) => deterministicVector(t, real.dimensions))),
  };
}

test("THE-460 Critical: declaring a revision reindexes, and vec_chunks + dense hits recover", async () => {
  const db = await openDatabase(":memory:");
  provisionCacheDb(db);

  const root = mkdtempSync(join(tmpdir(), "obtc-vec-revision-"));
  writeFileSync(join(root, "fox.md"), "# Fox\n\nthe quick brown fox jumps over the lazy dog");
  writeFileSync(join(root, "dog.md"), "# Dog\n\nthe lazy dog sleeps under the warm sun");
  const opts = { db, vaultId: "v", root, isReadable: () => true };

  const baseCfg: EmbeddingsConfigLike = { provider: "ollama", model: "bge-m3", dimensions: DIMS };

  // 1. Index with NO revision declared — the pre-existing, always-worked path. Dense hits > 0.
  const base = testProvider(baseCfg);
  expect(base.id).toBe("ollama:bge-m3"); // sanity: no revision -> no suffix
  const stats1 = await indexVault({ ...opts, provider: base });
  expect(stats1.vec_enabled).toBe(true);
  expect((db.prepare("SELECT count(*) AS c FROM vec_chunks").get() as { c: number }).c).toBe(2);
  const [q1] = await base.embed(["lazy dog"]);
  expect(semanticSearch(db, "v", q1 ?? [], { k: 2 }).length).toBeGreaterThan(0);

  // 2. Declare a revision at the SAME model name and width, and reindex. fp.model/dims/provider
  // are unchanged — ONLY `revision` moves the fingerprint, and ONLY the revision-suffixed
  // provider.id moves the re-embed gate + the backfill's activeModel. This is exactly the
  // reviewer's reproduction.
  const revised = testProvider({ ...baseCfg, revision: "chk2" });
  const stats2 = await indexVault({ ...opts, provider: revised, revision: "chk2" });
  expect(stats2.vec_enabled).toBe(true);

  // The Critical's assertion: vec_chunks must be NON-EMPTY, not dropped and left stranded.
  const rows2 = db.prepare("SELECT count(*) AS c FROM vec_chunks").get() as { c: number };
  expect(rows2.c).toBeGreaterThan(0);
  expect(rows2.c).toBe(2);
  const [q2] = await revised.embed(["lazy dog"]);
  expect(semanticSearch(db, "v", q2 ?? [], { k: 2 }).length).toBeGreaterThan(0); // hits recover

  // Review round 2 (Important): a row COUNT is identical whether the corpus was genuinely
  // re-embedded under the new checkpoint (fix B doing its job) or fix A's repaired backfill
  // merely PRESERVED the OLD checkpoint's vectors and relabeled them under a fingerprint that now
  // claims the new revision — with fix B reverted, chunk_embeddings.model / vec_chunks.model stay
  // "ollama:bge-m3" even after this step (the re-reviewer's measured reproduction), which is
  // exactly the "silently and subtly wrong" state THE-460 exists to prevent. Assert the STORED
  // IDENTITY against a HARDCODED literal — never `revised.id`, which would just echo back
  // whatever (possibly broken) value production computed and could never fail. Every active row
  // must carry the id the fingerprint now claims.
  expect(db.prepare("SELECT DISTINCT model FROM vec_chunks ORDER BY model").all()).toEqual([
    { model: "ollama:bge-m3@chk2" },
  ]);
  expect(
    db
      .prepare("SELECT DISTINCT model FROM chunk_embeddings WHERE is_active = 1 ORDER BY model")
      .all(),
  ).toEqual([{ model: "ollama:bge-m3@chk2" }]);

  // 3. A further reconcile at the SAME revision is a stable no-op (not "still 0 after a further
  // reconcile", the reviewer's second measured symptom).
  const stats3 = await indexVault({ ...opts, provider: revised, revision: "chk2" });
  expect(stats3.vec_enabled).toBe(true);
  expect((db.prepare("SELECT count(*) AS c FROM vec_chunks").get() as { c: number }).c).toBe(2);
  const [q3] = await revised.embed(["lazy dog"]);
  expect(semanticSearch(db, "v", q3 ?? [], { k: 2 }).length).toBeGreaterThan(0);

  // 4. Removing the revision setting again (a further fingerprint change) also recovers rather
  // than staying stranded (the reviewer's third measured symptom).
  const stats4 = await indexVault({ ...opts, provider: base });
  expect(stats4.vec_enabled).toBe(true);
  expect((db.prepare("SELECT count(*) AS c FROM vec_chunks").get() as { c: number }).c).toBe(2);
  const [q4] = await base.embed(["lazy dog"]);
  expect(semanticSearch(db, "v", q4 ?? [], { k: 2 }).length).toBeGreaterThan(0);

  // Identity reverts too: the stored rows must now carry the un-suffixed id again, not the
  // revisioned one left over from step 2/3 — same property, opposite direction, still hardcoded.
  expect(db.prepare("SELECT DISTINCT model FROM vec_chunks ORDER BY model").all()).toEqual([
    { model: "ollama:bge-m3" },
  ]);
  expect(
    db
      .prepare("SELECT DISTINCT model FROM chunk_embeddings WHERE is_active = 1 ORDER BY model")
      .all(),
  ).toEqual([{ model: "ollama:bge-m3" }]);

  rmSync(root, { recursive: true, force: true });
  db.close?.();
});
