// THE-501: computeNotePlan queried existing chunks once PER NOTE — N queries for a full reconcile.
// indexVault now preloads the whole vault's lightweight chunk state (ids + hashes + active model) in
// ONE query and plans every note from that map. This asserts the reconcile issues the bulk query and
// NOT the per-note query, and that preloadChunkState groups correctly and carries only identifiers.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Database } from "../src/db/types";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { indexVault, preloadChunkState } from "../src/search/indexer";
import { makeM2Vault } from "./m2-helpers";

const PER_NOTE = /FROM chunks c LEFT JOIN chunk_embeddings.*c\.path = \?/s;
const BULK = /FROM chunks c LEFT JOIN chunk_embeddings.*ORDER BY c\.path/s;

/** Wrap a db so we can count how many times each chunk-state query is EXECUTED (.all), not just
 *  prepared (cachedPrepare caches prepares, so prepare counts would not distinguish N notes). */
function countingDb(db: Database): { db: Database; perNote: () => number; bulk: () => number } {
  let perNote = 0;
  let bulk = 0;
  const proxy = new Proxy(db, {
    get(target, prop, recv) {
      if (prop === "prepare") {
        return (sql: string) => {
          const stmt = (target as Database).prepare(sql);
          if (PER_NOTE.test(sql) || BULK.test(sql)) {
            return new Proxy(stmt, {
              get(s, p, r) {
                if (p === "all") {
                  return (...a: unknown[]) => {
                    if (PER_NOTE.test(sql)) perNote += 1;
                    else if (BULK.test(sql)) bulk += 1;
                    return (s as { all: (...x: unknown[]) => unknown }).all(...a);
                  };
                }
                return Reflect.get(s, p, r);
              },
            });
          }
          return stmt;
        };
      }
      return Reflect.get(target, prop, recv);
    },
  }) as Database;
  return { db: proxy, perNote: () => perNote, bulk: () => bulk };
}

describe("THE-501 bulk chunk-state preload", () => {
  it("reconcile issues the bulk query, not one per note", async () => {
    const v = makeM2Vault({
      files: { "a.md": "# A\n\nalpha", "b.md": "# B\n\nbeta", "c.md": "# C\n\ngamma" },
      provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }),
    });
    // Seed an initial index so there is existing chunk state to load on the second pass.
    await indexVault({
      db: v.db,
      provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }),
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
    });

    const c = countingDb(v.db);
    await indexVault({
      db: c.db,
      provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }),
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
    });

    expect(c.bulk()).toBe(1); // one bulk load for the whole vault
    expect(c.perNote()).toBe(0); // never falls back to a per-note chunk query
    v.cleanup();
  });

  it("preloadChunkState groups by path and carries only ids/hashes/model", async () => {
    const v = makeM2Vault({
      files: { "a.md": "# A\n\nalpha alpha", "b.md": "# B\n\nbeta beta" },
      provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }),
    });
    await indexVault({
      db: v.db,
      provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }),
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
    });

    const map = preloadChunkState(v.db, v.id);
    expect(map.has("a.md")).toBe(true);
    expect(map.has("b.md")).toBe(true);
    const row = map.get("a.md")?.[0];
    expect(Object.keys(row ?? {}).sort()).toEqual(["active_model", "content_hash", "id"]);
    expect(row?.active_model).toBe("fake:A");
    v.cleanup();
  });

  it("still re-embeds only the note whose content changed (correctness preserved)", async () => {
    const v = makeM2Vault({
      files: { "a.md": "# A\n\nalpha", "b.md": "# B\n\nbeta" },
      provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }),
    });
    const opts = {
      provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }),
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
    };
    await indexVault({ db: v.db, ...opts });

    // Change only a.md, re-index; b.md must be unchanged (its content_hash still matches the preload).
    writeFileSync(join(v.root, "a.md"), "# A\n\nalpha rewritten entirely different");
    const stats = await indexVault({ db: v.db, ...opts });
    expect(stats.chunks_unchanged).toBeGreaterThan(0); // b.md's chunk skipped from the preload
    v.cleanup();
  });
});
