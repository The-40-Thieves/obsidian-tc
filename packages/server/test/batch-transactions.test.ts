// THE-500: index writes commit in bounded multi-note transactions. The prior flush was note-count
// only (BATCH=100 hardcoded), so a batch of large notes could make one oversized transaction, and the
// batch size was not configurable. This adds a byte budget AND makes both limits configurable, while
// keeping embedding OUTSIDE the write txn and preserving correctness (idempotent reconcile).
import { describe, expect, it } from "vitest";
import type { Database } from "../src/db/types";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { indexVault } from "../src/search/indexer";
import { makeM2Vault } from "./m2-helpers";

/** Count BEGIN statements (one per committed write transaction — notes flush + chunk flushes). Uses
 *  the same plain-object delegate as the P2 test rather than a Proxy (indexer only calls exec/prepare). */
function countingBegins(db: Database): { db: Database; begins: () => number } {
  let begins = 0;
  const wrapped: Database = {
    exec: (sql: string) => {
      if (sql === "BEGIN") begins += 1;
      return db.exec(sql);
    },
    prepare: (sql: string) => db.prepare(sql),
  } as Database;
  return { db: wrapped, begins: () => begins };
}

function vault() {
  const big = "x".repeat(400); // each note ~400 bytes of body
  return makeM2Vault({
    files: {
      "a.md": `# A\n\n${big}`,
      "b.md": `# B\n\n${big}`,
      "c.md": `# C\n\n${big}`,
      "d.md": `# D\n\n${big}`,
    },
    provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }),
  });
}

describe("THE-500 bounded batch transactions", () => {
  it("splits into more transactions under a small byte budget than under the default", async () => {
    const tight = vault();
    const ct = countingBegins(tight.db);
    await indexVault({
      db: ct.db,
      provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }),
      vaultId: tight.id,
      root: tight.root,
      isReadable: () => true,
      batch: { maxBytes: 200 }, // below one note's size -> flush after each note
    });
    const tightBegins = ct.begins();

    const loose = vault();
    const cl = countingBegins(loose.db);
    await indexVault({
      db: cl.db,
      provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }),
      vaultId: loose.id,
      root: loose.root,
      isReadable: () => true,
      // default byte budget (8 MiB) -> all four notes' chunks in ONE chunk transaction
    });
    const looseBegins = cl.begins();

    expect(tightBegins).toBeGreaterThan(looseBegins);
    tight.cleanup();
    loose.cleanup();
  });

  it("indexes every note's chunks regardless of the byte budget (correctness preserved)", async () => {
    const v = vault();
    await indexVault({
      db: v.db,
      provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }),
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
      batch: { maxBytes: 200 },
    });
    const chunks = (
      v.db.prepare("SELECT count(DISTINCT path) c FROM chunks WHERE vault_id = ?").get(v.id) as {
        c: number;
      }
    ).c;
    expect(chunks).toBe(4); // all four notes indexed even though each flushed separately
    v.cleanup();
  });

  it("honours a configurable maxNotes limit", async () => {
    const v = vault();
    const ct = countingBegins(v.db);
    await indexVault({
      db: ct.db,
      provider: fakeEmbeddingProvider({ dimensions: 32, model: "A" }),
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
      batch: { maxNotes: 1, maxBytes: 1 << 30 }, // flush every note by count, byte budget effectively off
    });
    // 4 note-count flushes for chunks + the notes-metadata flush(es) -> clearly more than the 2 a
    // single batched pass would produce.
    expect(ct.begins()).toBeGreaterThan(2);
    v.cleanup();
  });
});
