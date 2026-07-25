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
import { assignClusters } from "../src/search/cluster";
import { reconcileDerivedEdges, reconcileDerivedEdgesScoped } from "../src/search/derived-edges";
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

// THE-579: the counter's contract is "bumped on every content mutation that can change query
// results", but bumpGeneration had exactly three call sites, ALL in indexer.ts. Authored content was
// covered; the DERIVED plane was not. A densify pass over unchanged content rewrites vault_edges —
// which the graph-expansion stage walks whenever densify.includeInWalk is on — and a cluster pass
// rewrites chunks.cluster_id, which maxPerCluster diversification reads. Either changes what a query
// returns with no bump, which under THE-497's generation-keyed cache is the difference between a
// correct invalidation and a stale-until-TTL one.
//
// THE-496's asymmetry decides the shape: a MISSED bump silently serves stale results, an OVER-bump is
// merely a cache miss. So each writer bumps whenever it actually wrote, and a genuine no-op does not.
describe("THE-579 derived-plane writers bump the generation too", () => {
  const edge = (source: string, target: string, confidence = 0.9) => ({
    source_path: source,
    target_path: target,
    edge_type: "similar_to" as const,
    edge_kind: "virtual" as const,
    provenance: "cosine_knn",
    confidence,
    source_fingerprint: null,
  });

  it("reconcileDerivedEdges bumps when it inserts edges", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const before = readGeneration(db, "v1");
    const stats = reconcileDerivedEdges(db, "v1", [edge("a.md", "b.md")], ["similar_to"]);
    expect(stats.inserted).toBe(1); // the write really happened
    expect(readGeneration(db, "v1")).toBeGreaterThan(before);
  });

  it("reconcileDerivedEdges does NOT bump on an idempotent re-run (nothing written)", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    reconcileDerivedEdges(db, "v1", [edge("a.md", "b.md")], ["similar_to"]);
    const afterFirst = readGeneration(db, "v1");
    const stats = reconcileDerivedEdges(db, "v1", [edge("a.md", "b.md")], ["similar_to"]);
    expect(stats.inserted + stats.updated + stats.deleted).toBe(0); // genuinely a no-op
    expect(readGeneration(db, "v1")).toBe(afterFirst);
  });

  it("reconcileDerivedEdges bumps when it DELETES an edge (removal changes results too)", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    reconcileDerivedEdges(db, "v1", [edge("a.md", "b.md")], ["similar_to"]);
    const afterInsert = readGeneration(db, "v1");
    const stats = reconcileDerivedEdges(db, "v1", [], ["similar_to"]); // prune to empty
    expect(stats.deleted).toBe(1);
    expect(readGeneration(db, "v1")).toBeGreaterThan(afterInsert);
  });

  it("reconcileDerivedEdges bumps when it UPDATES confidence (ranking input changed)", () => {
    // An update is not a no-op: confidence is the edge weight the fused ranking reads.
    const db = openMemoryDb();
    provisionCacheDb(db);
    reconcileDerivedEdges(db, "v1", [edge("a.md", "b.md", 0.9)], ["similar_to"]);
    const afterInsert = readGeneration(db, "v1");
    const stats = reconcileDerivedEdges(db, "v1", [edge("a.md", "b.md", 0.4)], ["similar_to"]);
    expect(stats.updated).toBe(1);
    expect(readGeneration(db, "v1")).toBeGreaterThan(afterInsert);
  });

  it("reconcileDerivedEdgesScoped bumps on a real write and not on an empty scope", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const before = readGeneration(db, "v1");
    // Empty scope short-circuits before touching anything — must not bump.
    reconcileDerivedEdgesScoped(db, "v1", [], ["similar_to"], new Set());
    expect(readGeneration(db, "v1")).toBe(before);

    const stats = reconcileDerivedEdgesScoped(
      db,
      "v1",
      [edge("a.md", "b.md")],
      ["similar_to"],
      new Set(["a.md"]),
    );
    expect(stats.inserted).toBe(1);
    expect(readGeneration(db, "v1")).toBeGreaterThan(before);
  });

  it("the bump is per-vault: writing v1's edges leaves v2's generation alone", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    reconcileDerivedEdges(db, "v1", [edge("a.md", "b.md")], ["similar_to"]);
    expect(readGeneration(db, "v2")).toBe(0);
  });

  it("assignClusters bumps when it writes cluster_id", async () => {
    const v = makeM2Vault({
      files: { "a.md": "# A\n\nalpha", "b.md": "# B\n\nbeta" },
      provider: provider(),
    });
    await reindex(v.db, v);
    const before = readGeneration(v.db, v.id);
    const stats = assignClusters(v.db, v.id, { k: 2, seed: 1 });
    expect(stats?.chunks).toBeGreaterThan(0); // it really assigned
    expect(readGeneration(v.db, v.id)).toBeGreaterThan(before);
    v.cleanup();
  });

  it("assignClusters does NOT bump when there is nothing to cluster", () => {
    const db = openMemoryDb();
    provisionCacheDb(db);
    const before = readGeneration(db, "v1");
    expect(assignClusters(db, "v1", { k: 2, seed: 1 })).toBeNull(); // no embedded chunks
    expect(readGeneration(db, "v1")).toBe(before);
  });
});
