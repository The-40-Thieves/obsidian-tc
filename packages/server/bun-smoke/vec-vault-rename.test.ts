// GH #1014 fix round (HIGH, cross-vendor review): a renamed, already-indexed vault could never
// complete its re-key. `vec_chunks.vault_id` is a sqlite-vec0 PARTITION KEY, and
// `UPDATE vec_chunks SET vault_id = ?` throws "UPDATE on partition key columns are not supported
// yet" the moment the value actually changes — inside `inTransaction`, so the whole cache.db
// re-key rolled back and `vault_identity` stayed on the old id forever, retrying (and failing) the
// same way on every subsequent boot. node:sqlite (the vitest runtime) cannot load sqlite-vec at
// all, so `vault-identity.test.ts`'s suite was green on a path production never took after a real
// index — see that file's own inventory test, which excludes vec_chunks from the generic table
// diff for the same reason. This is the companion that runs where vec0 actually loads.
import { expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate";
import { EXPERIENTIAL_MIGRATION_FILES, versionOf } from "../src/db/migration-manifest";
import { embeddedSql } from "../src/db/migrations-embedded";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import { buildRepresentationManifest } from "../src/search/representation";
import { ensureVecChunks, floatBlob, vecKnn } from "../src/search/vec";
import { resolveAndApplyVaultIdentity } from "../src/vault/identity";

const DIMS = 8;

async function experientialDb() {
  const edb = await openDatabase(":memory:");
  runMigrations(
    edb,
    EXPERIENTIAL_MIGRATION_FILES.map((file) => ({
      version: versionOf(file),
      sql: embeddedSql(file),
    })),
  );
  return edb;
}

test("renaming an already-indexed vault re-keys vec_chunks instead of rolling back the whole re-key", async () => {
  const db = await openDatabase(":memory:");
  provisionCacheDb(db);
  const edb = await experientialDb();

  // First boot under the OLD id — this is the vault_identity insert, not a rename.
  expect(
    resolveAndApplyVaultIdentity(db, edb, [
      { id: "old-id", path: "/tmp/does-not-need-to-exist-for-this-test" },
    ]),
  ).toEqual([]);

  const manifest = buildRepresentationManifest(
    { provider: "fake", model: "m", dimensions: DIMS },
    {},
  );
  expect(ensureVecChunks(db, manifest, { activeModel: "fake:m" })).toBe(true);

  const now = Date.now();
  db.prepare(
    `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash, token_count, created_at, updated_at)
     VALUES ('c1', 'old-id', 'a.md', '0', '[]', 'x', 'hash', 1, ?, ?)`,
  ).run(now, now);
  const vec = new Float32Array(DIMS).fill(0.1);
  db.prepare(
    `INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at)
     VALUES ('c1', 'fake:m', ?, ?, 1, ?)`,
  ).run(DIMS, floatBlob(Array.from(vec)), now);
  db.prepare(
    "INSERT INTO vec_chunks (chunk_id, vault_id, path, model, embedding) VALUES (?, ?, ?, ?, ?)",
  ).run("c1", "old-id", "a.md", "fake:m", floatBlob(Array.from(vec)));

  // Second boot: SAME path, NEW id — a rename. Must not throw, and must not roll back.
  const notices = resolveAndApplyVaultIdentity(db, edb, [
    { id: "new-id", path: "/tmp/does-not-need-to-exist-for-this-test" },
  ]);
  expect(notices).toEqual([
    { oldId: "old-id", newId: "new-id", rootRealpath: "/tmp/does-not-need-to-exist-for-this-test" },
  ]);

  // chunks re-keyed (already covered under node:sqlite by vault-identity.test.ts).
  expect(
    (db.prepare("SELECT vault_id FROM chunks WHERE id = 'c1'").get() as { vault_id: string })
      .vault_id,
  ).toBe("new-id");

  // vec_chunks re-keyed: KNN finds it under the new id...
  const hitsNew = vecKnn(db, Array.from(vec), 5, "new-id");
  expect(hitsNew.map((h) => h.chunk_id)).toEqual(["c1"]);
  // ...and nothing remains under the old one.
  const hitsOld = vecKnn(db, Array.from(vec), 5, "old-id");
  expect(hitsOld).toEqual([]);
  const row = db.prepare("SELECT vault_id FROM vec_chunks WHERE chunk_id = 'c1'").get() as {
    vault_id: string;
  };
  expect(row.vault_id).toBe("new-id");
});
