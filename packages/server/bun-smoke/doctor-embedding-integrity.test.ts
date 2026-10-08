// GH #1160: the vec_chunks half of the index.embeddings probe — row count versus the active
// embeddings at the configured width. Needs sqlite-vec, so it lives in bun-smoke (see
// test/doctor-embedding-integrity.test.ts for the state-driven half).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/open";
import { provisionCacheDb } from "../src/db/provision";
import {
  embeddingIntegrityCheck,
  probeEmbeddingIntegrity,
} from "../src/doctor/embedding-integrity";
import { buildRepresentationManifest } from "../src/search/representation";
import { ensureVecChunks, floatBlob } from "../src/search/vec";

const DIMS = 16;

test("vec_chunks empty against active embeddings warns; a rebuild makes it agree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obtc-1160-vec-"));
  try {
    const db = await openDatabase(join(dir, "cache.db"));
    provisionCacheDb(db);
    const manifestFor = (model: string) =>
      buildRepresentationManifest({ provider: "fake", model, dimensions: DIMS }, {});
    ensureVecChunks(db, manifestFor("model-a"), { activeModel: "fake:model-a" });
    for (const id of ["c1", "c2", "c3"]) {
      db.prepare(
        `INSERT INTO chunks (id, vault_id, path, chunk_index, headings, content, content_hash,
                             token_count, created_at, updated_at)
         VALUES (?, 'v1', ?, '0', '[]', 'c', ?, 1, 0, 0)`,
      ).run(id, `${id}.md`, `h-${id}`);
      db.prepare(
        `INSERT INTO chunk_embeddings (chunk_id, model, dimensions, embedding, is_active, generated_at)
         VALUES (?, 'fake:model-a', ?, ?, 1, 0)`,
      ).run(id, DIMS, floatBlob(new Float32Array(DIMS).fill(0.1)));
    }
    db.close?.();

    // Embeddings exist and are active, but nothing was ever backfilled into vec_chunks.
    const empty = await probeEmbeddingIntegrity(dir, DIMS, 5_000);
    expect(empty).toMatchObject({ activeEmbeddings: 3, activeAtConfiguredWidth: 3, vecRows: 0 });
    const warned = await embeddingIntegrityCheck({ probe: () => empty }).run({
      serverVersion: "t",
    });
    expect(warned.status).toBe("warning");
    expect(warned.summary).toContain("missing 3 of 3");

    // A rebuild (fingerprint change) backfills them; the probe now agrees.
    const db2 = await openDatabase(join(dir, "cache.db"));
    ensureVecChunks(db2, manifestFor("model-b"), { activeModel: "fake:model-a" });
    db2.close?.();
    const full = await probeEmbeddingIntegrity(dir, DIMS, 5_000);
    expect(full?.vecRows).toBe(3);
    const ok = await embeddingIntegrityCheck({ probe: () => full }).run({ serverVersion: "t" });
    expect(ok.status).toBe("ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
