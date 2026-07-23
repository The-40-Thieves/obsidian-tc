// THE-486: kNN delta correctness — real end-to-end via indexVault + a REAL fakeEmbeddingProvider
// (deterministic bag-of-words vectors, so genuinely similar CONTENT produces genuinely similar
// vectors). sqlite-vec cannot load under vitest's node:sqlite (see densify-knn-floor.test.ts), so
// vecKnn is mocked — but as a REAL brute-force cosine search over the ACTUAL chunk_embeddings rows
// indexVault wrote (not a canned fixture), using the REAL blobToFloats. loadVec is mocked to true only
// for the derived-edges.ts import binding; ensureVecChunks (in vec.ts) calls loadVec via an INTRA-module
// reference untouched by vi.mock, so it still correctly reports no vec0 available and never touches
// vec_chunks — this test manually stands up an empty vec_chunks table just so derived-edges' own
// `hasVecChunks` existence probe passes.
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const vecKnnCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("../src/search/vec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/search/vec")>();
  function cosineDistance(a: Float32Array | number[], b: Float32Array | number[]): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      const av = a[i] as number;
      const bv = b[i] as number;
      dot += av * bv;
      na += av * av;
      nb += bv * bv;
    }
    if (na === 0 || nb === 0) return 1;
    return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
  }
  return {
    ...actual,
    loadVec: () => true,
    vecKnn: (db: any, query: number[], k: number, vaultId?: string) => {
      vecKnnCalls.count += 1;
      const rows = db
        .prepare(
          "SELECT c.id AS chunk_id, c.path AS path, e.embedding AS embedding FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE e.is_active = 1 AND c.vault_id = ?",
        )
        .all(vaultId) as Array<{ chunk_id: string; path: string; embedding: Uint8Array }>;
      const scored = rows.map((r) => ({
        chunk_id: r.chunk_id,
        path: r.path,
        distance: cosineDistance(query, [...actual.blobToFloats(r.embedding)]),
      }));
      scored.sort((a, b) => a.distance - b.distance);
      return scored.slice(0, k);
    },
  };
});

const { computeKnnEdges, reconcileDerivedEdges } = await import("../src/search/derived-edges");
const { indexVault } = await import("../src/search/indexer");
const { makeM2Vault } = await import("./m2-helpers");

// Three well-separated topic clusters (ML / cooking / finance) so k=1 nearest-neighbor forms exactly
// one edge per cluster — chosen empirically so within-cluster cosine sim is high (>.9) and
// cross-cluster sim stays low (<.35); see the THE-486 PR notes for the probe script.
const FILES = {
  "a.md": "gradient descent neural network training loss optimizer batch",
  "b.md": "neural network training gradient loss batch optimizer epoch",
  "c.md": "recipe pasta tomato basil garlic olive oil simmer dinner",
  "d.md": "pasta dinner basil tomato garlic recipe olive simmer sauce",
  "e.md": "quarterly revenue forecast budget spreadsheet finance report",
  "f.md": "revenue budget forecast finance quarterly spreadsheet report numbers",
};
// a.md rewritten to drift semantically INTO the cooking cluster (near c.md/d.md), away from b.md —
// the ticket's own neighbor-invalidation example: "changing chunk A's embedding can change whether
// B→A is a top-k edge, even though B itself did not change."
const A_EDITED = "pasta dinner recipe tomato basil garlic olive oil simmer tonight";

function knnRows(v: ReturnType<typeof makeM2Vault>): Array<{
  source_path: string;
  target_path: string;
  confidence: number;
}> {
  return v.db
    .prepare(
      "SELECT source_path, target_path, confidence FROM vault_edges WHERE vault_id = ? AND edge_type = 'similar_to' ORDER BY source_path, target_path",
    )
    .all(v.id) as Array<{ source_path: string; target_path: string; confidence: number }>;
}

function assertMatchesFullRecompute(v: ReturnType<typeof makeM2Vault>): void {
  const full = computeKnnEdges(v.db, v.id, { k: 1 });
  const stats = reconcileDerivedEdges(v.db, v.id, full, ["similar_to"], () => Date.now());
  expect(stats.inserted).toBe(0);
  expect(stats.deleted).toBe(0);
}

describe("THE-486 kNN delta — end to end via indexVault", () => {
  it("cold start does a full scan; a warm zero-change pass calls vecKnn ZERO times and leaves edges identical", async () => {
    const v = makeM2Vault({ files: FILES });
    v.db.exec("CREATE TABLE IF NOT EXISTS vec_chunks (dummy INTEGER)");
    const args = {
      db: v.db,
      provider: v.provider,
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
      densify: { knnEdges: true, knnK: 1 },
    };
    vecKnnCalls.count = 0;
    await indexVault(args); // cold start — one vecKnn call per chunk (6 notes, 1 chunk each)
    expect(vecKnnCalls.count).toBe(6);
    const baseline = knnRows(v);
    expect(baseline.map((r) => `${r.source_path}-${r.target_path}`)).toEqual([
      "a.md-b.md",
      "c.md-d.md",
      "e.md-f.md",
    ]);
    assertMatchesFullRecompute(v);

    vecKnnCalls.count = 0;
    await indexVault(args); // warm, nothing changed on disk
    // THE-486 acceptance criterion 1: a warm zero-change reindex performs NO full kNN scan — asserted
    // directly by counting vecKnn invocations, not by timing.
    expect(vecKnnCalls.count).toBe(0);
    expect(knnRows(v)).toEqual(baseline); // byte-for-byte identical, not merely "close enough"
    v.cleanup();
  });

  it("editing ONE note's content re-queries only it + its prior neighbor (2 calls, not 6) and matches full recompute", async () => {
    const v = makeM2Vault({ files: FILES });
    v.db.exec("CREATE TABLE IF NOT EXISTS vec_chunks (dummy INTEGER)");
    const args = {
      db: v.db,
      provider: v.provider,
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
      densify: { knnEdges: true, knnK: 1 },
    };
    await indexVault(args); // cold start

    v.write("a.md", A_EDITED);
    vecKnnCalls.count = 0;
    await indexVault(args);
    // scope = {a.md} (changed) ∪ {b.md} (a.md's ONLY prior similar_to neighbor) — NOT c/d/e/f.
    expect(vecKnnCalls.count).toBe(2);

    const rows = knnRows(v);
    expect(rows.map((r) => `${r.source_path}-${r.target_path}`)).toEqual([
      "a.md-b.md", // b.md's own best match is still a.md (weakly, but nothing else is closer)
      "a.md-c.md", // a.md's new best match
      "c.md-d.md", // untouched — neither c nor d changed, and d still ranks c as its own best
      "e.md-f.md", // completely untouched cluster
    ]);
    const ab = rows.find((r) => r.source_path === "a.md" && r.target_path === "b.md");
    const ac = rows.find((r) => r.source_path === "a.md" && r.target_path === "c.md");
    expect(ab?.confidence).toBeLessThan(0.5); // was ~.926, refreshed down after the edit
    expect(ac?.confidence).toBeGreaterThan(0.9); // brand new, high-confidence edge

    // The direct proof: a FULL recompute run immediately after finds NOTHING left to change.
    assertMatchesFullRecompute(v);
    v.cleanup();
  });

  it("deleting a note drops its similar_to edges in both directions and still matches full recompute", async () => {
    const v = makeM2Vault({ files: FILES });
    v.db.exec("CREATE TABLE IF NOT EXISTS vec_chunks (dummy INTEGER)");
    const args = {
      db: v.db,
      provider: v.provider,
      vaultId: v.id,
      root: v.root,
      isReadable: () => true,
      densify: { knnEdges: true, knnK: 1 },
    };
    await indexVault(args); // cold start
    unlinkSync(join(v.root, "f.md"));
    vecKnnCalls.count = 0;
    await indexVault(args);
    // scope = {f.md (deleted, no chunks left to query), e.md (its only prior neighbor)} — only ONE
    // outer vecKnn call, not a rescan of the whole (now 5-note) vault.
    expect(vecKnnCalls.count).toBe(1);
    const rows = knnRows(v);
    // f.md is gone in BOTH directions — no row names it as source or target.
    expect(rows.some((r) => r.source_path === "f.md" || r.target_path === "f.md")).toBe(false);
    // c.md-d.md is untouched (neither one changed, and neither was e.md's neighbor).
    expect(rows.map((r) => `${r.source_path}-${r.target_path}`)).toContain("c.md-d.md");
    // e.md finds SOME new best match now that f.md is gone (exactly which one is a coincidence of
    // the fixture's cosine geometry — assertMatchesFullRecompute below is the precise proof).
    expect(rows.some((r) => r.source_path === "e.md" || r.target_path === "e.md")).toBe(true);
    assertMatchesFullRecompute(v);
    v.cleanup();
  });
});
