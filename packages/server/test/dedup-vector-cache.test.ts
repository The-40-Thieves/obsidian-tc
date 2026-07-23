// THE-488: copyDedupVectors ran three JOIN SELECTs (embedding/sparse/colbert JOIN chunks WHERE
// body_sha=?) per SKIPPED chunk, inside the write transaction. In vaults with many duplicates
// (templates, canonical notes) that is a hot repeated JOIN. The source vectors for a given
// content_hash are identical for every duplicate, so they are now memoized per flush: the JOIN runs
// once per DISTINCT content_hash, not once per deduped chunk.
import { describe, expect, it } from "vitest";
import type { Database } from "../src/db/types";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { indexVault } from "../src/search/indexer";
import { makeM2Vault } from "./m2-helpers";

const DEDUP_SOURCE = /FROM chunk_embeddings e JOIN chunks c.*body_sha/s;

/** Count .get() executions of the dedup-source embedding JOIN. Plain-object delegate (indexer only
 *  calls exec/prepare), wrapping the matching statement so we count executions, not prepares. */
function countingDedupSource(db: Database): { db: Database; joins: () => number } {
  let joins = 0;
  const wrapped: Database = {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => {
      const stmt = db.prepare(sql);
      if (!DEDUP_SOURCE.test(sql)) return stmt;
      return new Proxy(stmt, {
        get(s, p, r) {
          if (p === "get") {
            return (...a: unknown[]) => {
              joins += 1;
              return (s as { get: (...x: unknown[]) => unknown }).get(...a);
            };
          }
          return Reflect.get(s, p, r);
        },
      });
    },
  } as Database;
  return { db: wrapped, joins: () => joins };
}

describe("THE-488 dedup-vector lookup memoization", () => {
  it("runs the source JOIN once per distinct content_hash, not once per deduped chunk", async () => {
    // Four notes with IDENTICAL body -> one owner embeds, three dedup-copy. One distinct content_hash.
    const body = "# H\n\nthis exact canonical paragraph is shared verbatim across many notes here";
    const v = makeM2Vault({
      files: { "a.md": body, "b.md": body, "c.md": body, "d.md": body },
      provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }),
    });
    const c = countingDedupSource(v.db);
    await indexVault({
      db: c.db,
      provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }),
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
    });

    // Three chunks were deduped, but the source JOIN ran at most once (one content_hash).
    expect(c.joins()).toBeLessThanOrEqual(1);
    v.cleanup();
  });

  it("still writes an embedding for every duplicate path (correctness preserved)", async () => {
    const body = "# H\n\nthis exact canonical paragraph is shared verbatim across many notes here";
    const v = makeM2Vault({
      files: { "a.md": body, "b.md": body, "c.md": body, "d.md": body },
      provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }),
    });
    await indexVault({
      db: v.db,
      provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }),
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
    });

    // Every path has an active embedding (dense-retrievable), not just the owner.
    const withEmb = (
      v.db
        .prepare(
          "SELECT count(DISTINCT c.path) n FROM chunks c JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.is_active = 1 WHERE c.vault_id = ?",
        )
        .get(v.id) as { n: number }
    ).n;
    expect(withEmb).toBe(4);
    v.cleanup();
  });
});
