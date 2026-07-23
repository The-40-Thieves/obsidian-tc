// THE-496: a monotonic per-vault generation counter, bumped on EVERY result-affecting mutation. A
// missed site silently serves stale cached results (THE-497), so this enumerates the content-mutation
// entry points (indexVault, indexNote, deindexNote) and asserts each bumps the counter — and that a
// warm no-op does NOT (over-invalidation is safe but churns the cache).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { provisionCacheDb } from "../src/db/provision";
import type { Database } from "../src/db/types";
import { fakeEmbeddingProvider } from "../src/embeddings";
import { bumpGeneration, readGeneration } from "../src/search/generation";
import { deindexNote, indexNote, indexVault } from "../src/search/indexer";
import { openMemoryDb } from "./helpers";
import { makeM2Vault } from "./m2-helpers";

const provider = () => fakeEmbeddingProvider({ dimensions: 32, model: "A" });
const reindex = (db: Database, v: ReturnType<typeof makeM2Vault>) =>
  indexVault({ db, provider: provider(), vaultId: v.id, root: v.root, isReadable: () => true });

describe("THE-496 vault_generation counter", () => {
  it("bumpGeneration increments monotonically; readGeneration reads it", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    expect(readGeneration(db, "v1")).toBe(0);
    expect(bumpGeneration(db, "v1")).toBe(1);
    expect(bumpGeneration(db, "v1")).toBe(2);
    expect(readGeneration(db, "v1")).toBe(2);
    // per-vault isolation
    expect(readGeneration(db, "v2")).toBe(0);
  });

  it("is a safe no-op on a pre-migration db (no vault_generation table)", () => {
    const db = openMemoryDb(); // no provisionCacheDb -> table absent
    expect(bumpGeneration(db, "v1")).toBe(0);
    expect(readGeneration(db, "v1")).toBe(0);
  });

  it("indexVault bumps the generation when it indexes content", async () => {
    const v = makeM2Vault({ files: { "a.md": "# A\n\nalpha" }, provider: provider() });
    const before = readGeneration(v.db, v.id);
    await reindex(v.db, v);
    expect(readGeneration(v.db, v.id)).toBeGreaterThan(before);
    v.cleanup();
  });

  it("a warm no-op reindex does NOT bump (nothing changed)", async () => {
    const v = makeM2Vault({ files: { "a.md": "# A\n\nalpha" }, provider: provider() });
    await reindex(v.db, v);
    const afterFirst = readGeneration(v.db, v.id);
    await reindex(v.db, v); // identical content -> no change
    expect(readGeneration(v.db, v.id)).toBe(afterFirst);
    v.cleanup();
  });

  it("indexNote bumps the generation when it writes a note", async () => {
    const v = makeM2Vault({ files: { "a.md": "# A\n\nalpha" }, provider: provider() });
    await reindex(v.db, v);
    const before = readGeneration(v.db, v.id);
    writeFileSync(join(v.root, "b.md"), "# B\n\nbeta new note");
    await indexNote(v.db, provider(), v.id, "b.md", "# B\n\nbeta new note", false, () => 1);
    expect(readGeneration(v.db, v.id)).toBeGreaterThan(before);
    v.cleanup();
  });

  it("deindexNote bumps the generation when it removes a note's chunks", async () => {
    const v = makeM2Vault({ files: { "a.md": "# A\n\nalpha" }, provider: provider() });
    await reindex(v.db, v);
    const before = readGeneration(v.db, v.id);
    deindexNote(v.db, v.id, "a.md", false);
    expect(readGeneration(v.db, v.id)).toBeGreaterThan(before);
    v.cleanup();
  });

  it("deindexNote of an unindexed path does not bump", async () => {
    const v = makeM2Vault({ files: { "a.md": "# A\n\nalpha" }, provider: provider() });
    await reindex(v.db, v);
    const before = readGeneration(v.db, v.id);
    deindexNote(v.db, v.id, "never-indexed.md", false);
    expect(readGeneration(v.db, v.id)).toBe(before);
    v.cleanup();
  });
});
