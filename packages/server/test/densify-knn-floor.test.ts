// Does a configured kNN similarity floor actually remove below-floor edges, THROUGH computeKnnEdges?
//
// The vec0 path cannot be exercised for real here: under vitest the db is node:sqlite, which cannot load
// the sqlite-vec extension (index_vault reports vec_enabled: false), so computeKnnEdges short-circuits to
// [] before any similarity is computed. Mocking the vec lookup is the only way to reach the filter. The
// OTHER half of the seam — that index_vault hands the configured floor down — is in
// densify-knn-wiring.test.ts, which cannot live in this file because the two mocks would collide.
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/search/vec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/search/vec")>();
  return {
    ...actual,
    loadVec: () => true, // pretend sqlite-vec is loaded
    blobToFloats: () => new Float32Array([1, 0, 0]),
    // vecKnn reports DISTANCE; derived-edges converts with sim = 1 - distance.
    vecKnn: () => [
      { chunk_id: "b1", path: "B.md", distance: 0.05 }, // sim 0.95
      { chunk_id: "c1", path: "C.md", distance: 0.38 }, // sim 0.62 — under a 0.8 floor, over a 0.5 one
    ],
  };
});

const { computeKnnEdges } = await import("../src/search/derived-edges");

/** computeKnnEdges reads the active-chunk rows and probes for vec_chunks; the lookup itself is mocked. */
function fakeDb(): any {
  return {
    prepare: (sql: string) => ({
      all: () =>
        sql.includes("chunk_embeddings") ? [{ path: "A.md", embedding: new Uint8Array(12) }] : [],
      // computeKnnEdges bails out early unless the vec_chunks table exists — say it does.
      get: () => (sql.includes("sqlite_master") ? { x: 1 } : undefined),
      run: () => ({ changes: 0 }),
    }),
    exec: () => {},
  };
}

describe("computeKnnEdges honors the configured similarity floor", () => {
  it("with the default floor (0), every neighbor the kNN returns becomes an edge", () => {
    const edges = computeKnnEdges(fakeDb(), "v1", { k: 8 });
    expect(edges.map((e) => e.target_path).sort()).toEqual(["B.md", "C.md"]);
  });

  it("a floor of 0.8 DROPS the 0.62 neighbor — the floor is not silently ignored", () => {
    const edges = computeKnnEdges(fakeDb(), "v1", { k: 8, minSim: 0.8 });
    // This is precisely the assertion the ablation's knn@0.80 arm rested on, and which nothing proved
    // through computeKnnEdges until now — the floor had only ever been tested one layer lower.
    expect(edges.map((e) => e.target_path)).toEqual(["B.md"]);
    expect(edges[0]?.confidence).toBeCloseTo(0.95, 3);
  });

  it("a floor above every neighbor yields no edges — not a crash, not a pass-through", () => {
    expect(computeKnnEdges(fakeDb(), "v1", { k: 8, minSim: 0.99 })).toEqual([]);
  });
});
