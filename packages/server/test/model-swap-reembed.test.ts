// THE-531: nothing caused a chunk to be re-embedded when the embedding MODEL changed. Re-embed was
// gated on content_hash (which does not include the model), and is_active was only ever set to 1, so
// a superseded model's rows were never deactivated. After THE-460 the vec0 rebuild stopped
// backfilling old-model vectors, so a model swap silently SHRANK the searchable corpus until each
// note's content happened to change — on a stable vault, indefinitely.
//
// Fix (lazy posture): compare the stored active-embedding model against the active model during
// reconcile and re-embed on mismatch, then deactivate the superseded rows so "active" means "current
// representation". This test asserts the corpus is fully re-embedded under the new model after a swap
// with NO note content changing.
import { describe, expect, it } from "vitest";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { indexVault } from "../src/search/indexer";
import { makeM2Vault } from "./m2-helpers";

function activeEmbeddings(
  db: import("../src/db/types").Database,
): { chunk_id: string; model: string }[] {
  return db
    .prepare("SELECT chunk_id, model FROM chunk_embeddings WHERE is_active = 1 ORDER BY chunk_id")
    .all() as { chunk_id: string; model: string }[];
}

describe("THE-531 model-swap re-embed", () => {
  it("re-embeds every chunk under the new model on reconcile, with no content change", async () => {
    const v = makeM2Vault({
      files: { "a.md": "# A\n\nalpha content here", "b.md": "# B\n\nbeta content here" },
      provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }),
    });
    const opts = { db: v.db, vaultId: v.id, root: v.root, isReadable: () => true };

    await indexVault({ ...opts, provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }) });
    const before = activeEmbeddings(v.db);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((r) => r.model === "fake:A")).toBe(true);

    // Swap the model. Same dimension, SAME content. Nothing in the notes changed.
    await indexVault({ ...opts, provider: fakeEmbeddingProvider({ dimensions: 32, model: "B" }) });

    const after = activeEmbeddings(v.db);
    // every chunk is now active under the new model — full corpus searchable again
    expect(after.length).toBe(before.length);
    expect(after.every((r) => r.model === "fake:B")).toBe(true);
    expect(after.map((r) => r.chunk_id).sort()).toEqual(before.map((r) => r.chunk_id).sort());

    v.cleanup();
  });

  it("deactivates the superseded-model rows rather than leaving them active", async () => {
    const v = makeM2Vault({
      files: { "a.md": "# A\n\nalpha content here" },
      provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }),
    });
    const opts = { db: v.db, vaultId: v.id, root: v.root, isReadable: () => true };

    await indexVault({ ...opts, provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }) });
    await indexVault({ ...opts, provider: fakeEmbeddingProvider({ dimensions: 32, model: "B" }) });

    // The old (chunk_id, "fake:A") rows still exist (PRIMARY KEY chunk_id,model lets both coexist)
    // but must be is_active = 0 — "active" now means "current representation".
    const oldActive = v.db
      .prepare("SELECT count(*) c FROM chunk_embeddings WHERE model = 'fake:A' AND is_active = 1")
      .get() as { c: number };
    expect(oldActive.c).toBe(0);

    const newActive = v.db
      .prepare("SELECT count(*) c FROM chunk_embeddings WHERE model = 'fake:B' AND is_active = 1")
      .get() as { c: number };
    expect(newActive.c).toBeGreaterThan(0);

    v.cleanup();
  });

  it("does not re-embed when neither content nor model changed (no churn)", async () => {
    const v = makeM2Vault({
      files: { "a.md": "# A\n\nalpha content here" },
      provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }),
    });
    const opts = { db: v.db, vaultId: v.id, root: v.root, isReadable: () => true };
    await indexVault({ ...opts, provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }) });
    const first = (
      v.db
        .prepare("SELECT generated_at FROM chunk_embeddings WHERE is_active = 1 LIMIT 1")
        .get() as {
        generated_at: number;
      }
    ).generated_at;

    // Same model, same content -> the second pass must be a warm no-op (generated_at unchanged).
    await indexVault({ ...opts, provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }) });
    const second = (
      v.db
        .prepare("SELECT generated_at FROM chunk_embeddings WHERE is_active = 1 LIMIT 1")
        .get() as {
        generated_at: number;
      }
    ).generated_at;
    expect(second).toBe(first);

    v.cleanup();
  });
});
