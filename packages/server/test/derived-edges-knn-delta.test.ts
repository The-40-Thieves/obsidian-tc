// THE-486: computeKnnEdgesForPaths + knnNeighborScope — the kNN half of delta densification.
//
// Real sqlite-vec cannot load under vitest's node:sqlite (see densify-knn-floor.test.ts), so vecKnn is
// mocked. blobToFloats is mocked to an IDENTITY passthrough and each fixture chunk's "embedding" is a
// single byte identifying its NOTE (65='A.md', 66='B.md', ...) — so the mocked vecKnn can look up a
// per-source canned neighbor list keyed on the query it was actually called with, instead of one fixed
// return value for every call. This lets a single fixture model a small multi-note neighborhood
// precisely enough to prove the delta-vs-full divergence the ticket calls out.
import { describe, expect, it, vi } from "vitest";

type Hit = { chunk_id: string; path: string; distance: number };

// "BEFORE" is the neighborhood a full recompute would have produced BEFORE this pass (the prior,
// already-reconciled baseline). "AFTER" is what the SAME notes' OWN vecKnn call would return if
// actually re-queried THIS pass (A.md's content changed and drifted semantically toward C.md, away
// from B.md; D/E/F are physically unaffected — their AFTER entries are identical to BEFORE).
const BEFORE: Record<number, Hit[]> = {
  65: [
    { chunk_id: "b", path: "B.md", distance: 0.1 }, // sim .9
    { chunk_id: "c", path: "C.md", distance: 0.5 }, // sim .5
  ], // A.md
  66: [{ chunk_id: "a", path: "A.md", distance: 0.1 }], // B.md, sim .9
  67: [{ chunk_id: "a", path: "A.md", distance: 0.5 }], // C.md, sim .5
  68: [{ chunk_id: "a", path: "A.md", distance: 0.99 }], // D.md, sim .01
  69: [{ chunk_id: "f", path: "F.md", distance: 0.05 }], // E.md, sim .95
  70: [{ chunk_id: "e", path: "E.md", distance: 0.05 }], // F.md, sim .95
};
const AFTER: Record<number, Hit[]> = {
  ...BEFORE,
  65: [
    { chunk_id: "c", path: "C.md", distance: 0.05 }, // A.md now much closer to C — sim .95
    { chunk_id: "b", path: "B.md", distance: 0.6 }, // and much farther from B — sim .4
  ],
  66: [{ chunk_id: "a", path: "A.md", distance: 0.6 }], // sim .4 (only observed if B is re-queried)
  67: [{ chunk_id: "a", path: "A.md", distance: 0.05 }], // sim .95 (only observed if C is re-queried)
};

let phase: "before" | "after" = "before";

vi.mock("../src/search/vec", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/search/vec")>();
  return {
    ...actual,
    loadVec: () => true,
    blobToFloats: (blob: Uint8Array) => blob, // identity — the single byte IS the "vector"
    vecKnn: (_db: unknown, query: number[], k: number) => {
      const table = phase === "before" ? BEFORE : AFTER;
      return (table[query[0] as number] ?? []).slice(0, k);
    },
  };
});

const {
  computeKnnEdges,
  computeKnnEdgesForPaths,
  knnNeighborScope,
  reconcileDerivedEdges,
  reconcileDerivedEdgesScoped,
} = await import("../src/search/derived-edges");

const ALL_ROWS = [
  { path: "A.md", embedding: new Uint8Array([65]) },
  { path: "B.md", embedding: new Uint8Array([66]) },
  { path: "C.md", embedding: new Uint8Array([67]) },
  { path: "D.md", embedding: new Uint8Array([68]) },
  { path: "E.md", embedding: new Uint8Array([69]) },
  { path: "F.md", embedding: new Uint8Array([70]) },
];

/** A fake db: chunk_embeddings/chunks JOIN (optionally filtered by "c.path IN (...)"), plus a real
 *  vault_edges table (so reconcileDerivedEdges / knnNeighborScope's own SELECT run for real). */
function fakeDb(): any {
  const edges: Array<{
    vault_id: string;
    source_path: string;
    target_path: string;
    edge_type: string;
    confidence: number | null;
  }> = [];
  return {
    prepare: (sql: string) => ({
      all: (...args: unknown[]) => {
        if (sql.includes("sqlite_master")) return [];
        if (sql.includes("chunk_embeddings")) {
          if (sql.includes("c.path IN")) {
            const scope = new Set(args.slice(1) as string[]);
            return ALL_ROWS.filter((r) => scope.has(r.path));
          }
          return ALL_ROWS;
        }
        if (sql.startsWith("SELECT source_path, target_path FROM vault_edges")) {
          const [vaultId, ...rest] = args as [string, ...string[]];
          const scope = new Set(rest);
          return edges.filter(
            (e) =>
              e.vault_id === vaultId &&
              e.edge_type === "similar_to" &&
              (scope.has(e.source_path) || scope.has(e.target_path)),
          );
        }
        if (sql.startsWith("SELECT source_path, target_path, edge_type FROM vault_edges")) {
          // reconcileDerivedEdgesCore's "current" query. Every call in this file passes exactly ONE
          // edge_type, so args = [vaultId, edgeType, ...scopeParams] (scopeParams present only when
          // the SQL carries the scope clause — reconcileDerivedEdgesScoped duplicates scope as
          // (source_path IN (...) OR target_path IN (...)), so dedup via a Set recovers it).
          const [vaultId, edgeType, ...scopeParams] = args as [string, string, ...string[]];
          const scope = sql.includes("source_path IN") ? new Set(scopeParams) : null;
          return edges.filter(
            (e) =>
              e.vault_id === vaultId &&
              e.edge_type === edgeType &&
              (!scope || scope.has(e.source_path) || scope.has(e.target_path)),
          );
        }
        return [];
      },
      get: () => (sql.includes("sqlite_master") ? { x: 1 } : undefined),
      run: (...args: unknown[]) => {
        if (sql.startsWith("DELETE")) {
          const [vaultId, sourcePath, targetPath, edgeType] = args as string[];
          const i = edges.findIndex(
            (e) =>
              e.vault_id === vaultId &&
              e.source_path === sourcePath &&
              e.target_path === targetPath &&
              e.edge_type === edgeType,
          );
          if (i >= 0) edges.splice(i, 1);
        } else if (sql.startsWith("INSERT")) {
          // up.run(vaultId, source, target, edgeType, edgeKind, provenance, confidence, ...)
          const [vaultId, sourcePath, targetPath, edgeType, , , confidence] = args as [
            string,
            string,
            string,
            string,
            string,
            string,
            number | null,
          ];
          const i = edges.findIndex(
            (e) =>
              e.vault_id === vaultId &&
              e.source_path === sourcePath &&
              e.target_path === targetPath &&
              e.edge_type === edgeType,
          );
          if (i >= 0) edges.splice(i, 1);
          edges.push({
            vault_id: vaultId,
            source_path: sourcePath,
            target_path: targetPath,
            edge_type: edgeType,
            confidence,
          });
        }
        return { changes: 0 };
      },
    }),
    exec: () => {},
    __edges: edges,
  };
}

describe("computeKnnEdgesForPaths", () => {
  it("returns [] on an empty scope — no query at all", () => {
    phase = "before";
    expect(computeKnnEdgesForPaths(fakeDb(), "v1", new Set())).toEqual([]);
  });

  it("queries ONLY the scope's own notes as source — a note outside scope is never a source", () => {
    phase = "before";
    const edges = computeKnnEdgesForPaths(fakeDb(), "v1", new Set(["A.md"]));
    // A.md's OWN before-list: B (.9), C (.5) — nothing from B/C/D/E/F's perspective (out of scope).
    expect(edges.map((e) => `${e.source_path}-${e.target_path}:${e.confidence}`).sort()).toEqual([
      "A.md-B.md:0.9",
      "A.md-C.md:0.5",
    ]);
  });

  it("matches computeKnnEdges' output when scope covers every note that could be a source", () => {
    phase = "before";
    const full = computeKnnEdges(fakeDb(), "v1");
    const scoped = computeKnnEdgesForPaths(
      fakeDb(),
      "v1",
      new Set(["A.md", "B.md", "C.md", "D.md", "E.md", "F.md"]),
    );
    const norm = (es: typeof full) =>
      es.map((e) => `${e.source_path}-${e.target_path}:${e.confidence}`).sort();
    expect(norm(scoped)).toEqual(norm(full));
    expect(full.length).toBeGreaterThan(0); // sanity: the fixture actually produces edges
  });
});

describe("knnNeighborScope", () => {
  it("empty `changed` short-circuits to itself with no query", () => {
    expect(knnNeighborScope(fakeDb(), "v1", new Set())).toEqual(new Set());
  });

  it("expands to a changed note's EXISTING similar_to neighbors, both directions, and nothing else", () => {
    const db = fakeDb();
    reconcileDerivedEdges(
      db,
      "v1",
      [
        mkSim("A.md", "B.md", 0.9),
        mkSim("A.md", "C.md", 0.5),
        mkSim("A.md", "D.md", 0.01),
        mkSim("E.md", "F.md", 0.95), // an unrelated cluster — must NOT be pulled in
      ],
      ["similar_to"],
      () => 1,
    );
    const scope = knnNeighborScope(db, "v1", new Set(["A.md"]));
    expect(scope).toEqual(new Set(["A.md", "B.md", "C.md", "D.md"]));
  });
});

function mkSim(s: string, t: string, confidence: number) {
  return {
    source_path: s,
    target_path: t,
    edge_type: "similar_to" as const,
    edge_kind: "virtual" as const,
    provenance: "cosine_knn",
    confidence,
    source_fingerprint: null,
  };
}

describe("THE-486 neighbor invalidation — delta WITHOUT neighbor expansion diverges from full recompute", () => {
  it("scope = knnNeighborScope(changed) matches full recompute; scope = changed-only does NOT", () => {
    // Two independently-seeded dbs, both starting from the SAME prior, already-converged BEFORE
    // baseline (as a real full pass would have left it) — one gets the DELTA treatment, the other a
    // from-scratch FULL recompute, and the two FINAL vault_edges states are compared.
    const seed = (): any => {
      const db = fakeDb();
      phase = "before";
      reconcileDerivedEdges(db, "v1", computeKnnEdges(db, "v1"), ["similar_to"], () => 1);
      return db;
    };
    const finalKeys = (db: any): string[] =>
      (db.__edges as Array<{ source_path: string; target_path: string }>)
        .map((e) => `${e.source_path}-${e.target_path}`)
        .sort();

    const dbDelta = seed();
    const dbFull = seed();
    expect(finalKeys(dbDelta)).toEqual(["A.md-B.md", "A.md-C.md", "A.md-D.md", "E.md-F.md"]);

    // A.md's content changed this pass; the embedding provider now returns the AFTER vectors.
    phase = "after";
    const changed = new Set(["A.md"]);

    // CORRECT delta: scope includes A's prior edge-neighbors (B, C, D), so they get re-queried too.
    const correctScope = knnNeighborScope(dbDelta, "v1", changed);
    expect(correctScope).toEqual(new Set(["A.md", "B.md", "C.md", "D.md"]));
    const correctDesired = computeKnnEdgesForPaths(dbDelta, "v1", correctScope);
    reconcileDerivedEdgesScoped(
      dbDelta,
      "v1",
      correctDesired,
      ["similar_to"],
      correctScope,
      () => 2,
    );

    // FULL recompute of the same AFTER state, from scratch, for comparison.
    reconcileDerivedEdges(dbFull, "v1", computeKnnEdges(dbFull, "v1"), ["similar_to"], () => 2);

    // The two FINAL states are identical — this is the delta-vs-full equivalence the ticket requires.
    expect(finalKeys(dbDelta)).toEqual(finalKeys(dbFull));
    expect(finalKeys(dbDelta)).toEqual(["A.md-B.md", "A.md-C.md", "A.md-D.md", "E.md-F.md"]);
    const dbDeltaAC = (dbDelta.__edges as Array<{ target_path: string; confidence: number }>).find(
      (e) => e.target_path === "C.md",
    );
    expect(dbDeltaAC?.confidence).toBeCloseTo(0.95, 3); // refreshed from .5 to .95, not left stale

    // WRONG: recomputing ONLY the changed note (no neighbor expansion) — the classic trap this
    // guards against. Applied to a THIRD, independently-seeded db so the correct run above is
    // untouched.
    const dbWrong = seed();
    phase = "after";
    const wrongScope = changed; // no knnNeighborScope expansion
    const wrongDesired = computeKnnEdgesForPaths(dbWrong, "v1", wrongScope);
    reconcileDerivedEdgesScoped(dbWrong, "v1", wrongDesired, ["similar_to"], wrongScope, () => 2);
    // A.md's own AFTER list only mentions B and C — D is missing entirely, because the only reason
    // A-D existed was D's OWN perspective (D ranked A in D's top-k), and D is never re-queried here.
    // Worse than merely stale: A is IN scope (an endpoint of A-D), so the scoped delete sees A-D as
    // absent from desired and REMOVES a still-valid edge — a real divergence from the full recompute,
    // not just a missed update.
    expect(finalKeys(dbWrong)).not.toEqual(finalKeys(dbFull));
    expect(finalKeys(dbWrong)).not.toContain("A.md-D.md");
  });
});
