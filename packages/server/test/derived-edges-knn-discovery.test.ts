// THE-533: the delta-kNN DISCOVERY gap left open by THE-486, and the scope widening that closes it.
//
// THE-486's delta expands 1 hop over EXISTING `similar_to` edges (knnNeighborScope). A brand-new note
// has no edges, so that expansion returns only the note itself — and any note that would now rank the
// new note in its OWN top-k, but which the new note does not rank back, is never re-queried and never
// discovers the edge.
//
// WHY SUCH A NOTE CAN EXIST AT ALL — the part that makes this fixture non-obvious:
// cosine similarity is SYMMETRIC. sim(X, N) is always sim(N, X). The asymmetry is entirely in the
// top-k CUT, not in the score. So the gap requires a specific shape:
//
//   - N joins a DENSE cluster (P, Q at sim .98/.97). N's own top-k is saturated by them.
//   - X sits in a SPARSE region. Its best neighbour before N existed was P at sim .10.
//   - sim(N, X) = .60 — too weak to make N's top-2, but easily X's new best match.
//
// So X ranks N #1 while N ranks X #3. Only X's own re-query can discover the edge, and X is not in the
// delta scope. That is the whole bug, and it is why "just expand over existing edges" cannot see it.
//
// Mocking follows derived-edges-knn-delta.test.ts exactly: sqlite-vec cannot load under vitest's
// node:sqlite, so vecKnn is mocked and blobToFloats is an identity passthrough over a single byte that
// identifies the NOTE (78='N.md', 80='P.md', 81='Q.md', 88='X.md').
import { describe, expect, it, vi } from "vitest";

type Hit = { chunk_id: string; path: string; distance: number };

// BEFORE: the converged baseline of a 3-note vault. N.md does not exist yet.
const BEFORE: Record<number, Hit[]> = {
  80: [{ chunk_id: "q", path: "Q.md", distance: 0.01 }], // P.md -> Q sim .99
  81: [{ chunk_id: "p", path: "P.md", distance: 0.01 }], // Q.md -> P sim .99
  88: [{ chunk_id: "p", path: "P.md", distance: 0.9 }], // X.md -> P sim .10 (sparse region)
};

// AFTER: N.md has been added this pass. Note the SYMMETRY of every pair — N/X is .60 read from either
// side. What differs is only whether .60 survives that note's top-2 cut.
const AFTER: Record<number, Hit[]> = {
  78: [
    { chunk_id: "p", path: "P.md", distance: 0.02 }, // sim .98
    { chunk_id: "q", path: "Q.md", distance: 0.03 }, // sim .97
    { chunk_id: "x", path: "X.md", distance: 0.4 }, // sim .60 — THIRD, so cut from N's top-2
  ],
  80: [
    { chunk_id: "q", path: "Q.md", distance: 0.01 }, // .99
    { chunk_id: "n", path: "N.md", distance: 0.02 }, // .98
  ],
  81: [
    { chunk_id: "p", path: "P.md", distance: 0.01 }, // .99
    { chunk_id: "n", path: "N.md", distance: 0.03 }, // .97
  ],
  88: [
    { chunk_id: "n", path: "N.md", distance: 0.4 }, // sim .60 — X's new BEST match
    { chunk_id: "p", path: "P.md", distance: 0.9 }, // .10
  ],
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
  knnDiscoveryScope,
  knnNeighborScope,
  reconcileDerivedEdges,
  reconcileDerivedEdgesScoped,
} = await import("../src/search/derived-edges");

const K = { k: 2 };

const ROWS_BEFORE = [
  { path: "P.md", embedding: new Uint8Array([80]) },
  { path: "Q.md", embedding: new Uint8Array([81]) },
  { path: "X.md", embedding: new Uint8Array([88]) },
];
const ROWS_AFTER = [{ path: "N.md", embedding: new Uint8Array([78]) }, ...ROWS_BEFORE];

/** Same fake db as derived-edges-knn-delta.test.ts; the chunk row set follows `phase` so that N.md
 *  genuinely does not exist during the BEFORE seed. */
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
        // THE-579: reconcileDerivedEdgesCore probes for the densification columns before selecting
        // them. Answer honestly so these tests exercise the SAME path production takes, rather than
        // silently falling back to the pre-migration branch.
        if (sql.startsWith("PRAGMA table_info(vault_edges)")) {
          return [
            { name: "source_path" },
            { name: "target_path" },
            { name: "edge_type" },
            { name: "edge_kind" },
            { name: "provenance" },
            { name: "confidence" },
            { name: "source_fingerprint" },
          ];
        }
        if (sql.includes("chunk_embeddings")) {
          const rows = phase === "before" ? ROWS_BEFORE : ROWS_AFTER;
          if (sql.includes("c.path IN")) {
            const scope = new Set(args.slice(1) as string[]);
            return rows.filter((r) => scope.has(r.path));
          }
          return rows;
        }
        // THE-533 prune lookup. Must be checked BEFORE the bare source/target query below, and its
        // confidences must be real: returning [] here would silently disable the prune and let the
        // cost-bound test pass for the wrong reason.
        if (sql.startsWith("SELECT source_path, target_path, confidence FROM vault_edges")) {
          const [vaultId, ...rest] = args as [string, ...string[]];
          const scope = new Set(rest);
          return edges.filter(
            (e) =>
              e.vault_id === vaultId &&
              e.edge_type === "similar_to" &&
              (scope.has(e.source_path) || scope.has(e.target_path)),
          );
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
        if (
          sql.startsWith(
            "SELECT source_path, target_path, edge_type, edge_kind, provenance, confidence, source_fingerprint FROM vault_edges",
          )
        ) {
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
        } else if (sql.startsWith("INSERT INTO vault_generation")) {
          // THE-579: reconcile now bumps the generation inside the same transaction. This fake's
          // edge store must not swallow that INSERT as an edge row — matching bare "INSERT" did
          // exactly that and materialised a phantom edge.
          return { changes: 1 };
        } else if (sql.startsWith("INSERT")) {
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

const finalKeys = (db: any): string[] =>
  (db.__edges as Array<{ source_path: string; target_path: string }>)
    .map((e) => `${e.source_path}-${e.target_path}`)
    .sort();

/** Seed a db with the converged BEFORE baseline, exactly as a prior full pass would have left it. */
function seed(): any {
  const db = fakeDb();
  phase = "before";
  reconcileDerivedEdges(db, "v1", computeKnnEdges(db, "v1", K), ["similar_to"], () => 1);
  return db;
}

describe("THE-533 delta-kNN discovery gap", () => {
  it("the fixture really is asymmetric: X ranks N first, N does not rank X at all", () => {
    // Guards the fixture itself. If a later edit flattens this asymmetry the gap tests below would
    // pass vacuously, so assert the precondition the whole file depends on.
    phase = "after";
    const fromN = computeKnnEdgesForPaths(fakeDb(), "v1", new Set(["N.md"]), K);
    const fromX = computeKnnEdgesForPaths(fakeDb(), "v1", new Set(["X.md"]), K);
    expect(fromN.map((e) => `${e.source_path}-${e.target_path}`).sort()).toEqual([
      "N.md-P.md",
      "N.md-Q.md",
    ]); // N's top-2 is saturated by the dense cluster — X is cut
    expect(fromX.map((e) => `${e.source_path}-${e.target_path}`)).toContain("N.md-X.md"); // but X ranks N
  });

  it("DEMONSTRATES THE GAP: knnNeighborScope on a brand-new note misses the edge full recompute finds", () => {
    // This is the characterization the ticket asks for FIRST: prove the current path is wrong before
    // changing it. It documents present-day behaviour and must keep passing after the fix.
    const dbDelta = seed();
    const dbFull = seed();
    expect(finalKeys(dbDelta)).toEqual(["P.md-Q.md", "P.md-X.md"]);

    phase = "after";
    const changed = new Set(["N.md"]); // N.md is brand new this pass

    const scope = knnNeighborScope(dbDelta, "v1", changed);
    expect(scope).toEqual(new Set(["N.md"])); // no existing edges to expand over — the root cause
    reconcileDerivedEdgesScoped(
      dbDelta,
      "v1",
      computeKnnEdgesForPaths(dbDelta, "v1", scope, K),
      ["similar_to"],
      scope,
      () => 2,
    );

    reconcileDerivedEdges(dbFull, "v1", computeKnnEdges(dbFull, "v1", K), ["similar_to"], () => 2);

    expect(finalKeys(dbFull)).toContain("N.md-X.md"); // full recompute finds it
    expect(finalKeys(dbDelta)).not.toContain("N.md-X.md"); // the delta path does NOT
    expect(finalKeys(dbDelta)).not.toEqual(finalKeys(dbFull)); // => not equivalent
  });

  it("knnDiscoveryScope closes it: delta output becomes identical to full recompute", () => {
    const dbDelta = seed();
    const dbFull = seed();

    phase = "after";
    const changed = new Set(["N.md"]);

    const scope = knnDiscoveryScope(dbDelta, "v1", changed, K);
    // Widened by N's own forward vector neighbours — which DOES include X, because vecKnn over-fetches
    // (k*4+1 chunks) and the discovery scope reads that raw pool, before the per-note top-k cut that
    // dropped X from N's edges.
    expect(scope).toEqual(new Set(["N.md", "P.md", "Q.md", "X.md"]));
    reconcileDerivedEdgesScoped(
      dbDelta,
      "v1",
      computeKnnEdgesForPaths(dbDelta, "v1", scope, K),
      ["similar_to"],
      scope,
      () => 2,
    );

    reconcileDerivedEdges(dbFull, "v1", computeKnnEdges(dbFull, "v1", K), ["similar_to"], () => 2);

    expect(finalKeys(dbDelta)).toEqual(finalKeys(dbFull));
    expect(finalKeys(dbDelta)).toContain("N.md-X.md");
  });

  it("preserves the scoped-reconcile invariant: every desired edge touches scope", () => {
    // reconcileDerivedEdgesScoped THROWS when a desired edge lies wholly outside scope (such an edge
    // could never be deleted by a later scoped pass and would be orphaned). A scope widening is the
    // exact change that could break this, so assert it directly rather than trusting the reconcile.
    phase = "after";
    const db = seed();
    phase = "after";
    const scope = knnDiscoveryScope(db, "v1", new Set(["N.md"]), K);
    for (const e of computeKnnEdgesForPaths(db, "v1", scope, K)) {
      expect(scope.has(e.source_path) || scope.has(e.target_path)).toBe(true);
    }
  });

  it("prunes candidates that already have k strictly-closer neighbours — the cost bound", () => {
    // The scope must not simply absorb the whole over-fetch pool, or a delta pass degenerates toward a
    // full scan and THE-486's speedup is given back.
    //
    // The prune is sound because a stored `similar_to` confidence IS the cosine similarity, and cosine
    // similarity is SYMMETRIC. So if candidate C already has k neighbours strictly closer than
    // sim(changed, C), the changed note cannot displace any of them and C's top-k is untouchable —
    // no re-query needed. Note this holds regardless of WHY each edge was stored (either endpoint may
    // have earned it); all that matters is that k genuinely-closer notes demonstrably exist.
    //
    // Read at k=1 on the same fixture: P and Q each already have a .99 neighbour, which beats their
    // .98/.97 similarity to N, so both are pruned. X's only edge is .10, far below its .60 to N, so X
    // survives the prune — which is exactly the note the discovery gap was about.
    // P.md reappears NOT as a discovery candidate — it is pruned as one — but via the edge-closure
    // below: X.md survives the prune and drags its existing X.md-P.md neighbour in. Q.md, which has no
    // edge to any scope member, stays out. That is the prune doing its job.
    const db = seed();
    phase = "after";
    expect(knnDiscoveryScope(db, "v1", new Set(["N.md"]), { k: 1 })).toEqual(
      new Set(["N.md", "X.md", "P.md"]),
    );
  });

  it("the prune does not cost equivalence: pruned delta still matches full recompute at k=1", () => {
    // A cost optimisation that broke correctness would be worse than the bug. Same k=1 run, compared
    // against a full recompute end to end.
    const dbDelta = seed();
    const dbFull = seed();
    phase = "after";
    const scope = knnDiscoveryScope(dbDelta, "v1", new Set(["N.md"]), { k: 1 });
    reconcileDerivedEdgesScoped(
      dbDelta,
      "v1",
      computeKnnEdgesForPaths(dbDelta, "v1", scope, { k: 1 }),
      ["similar_to"],
      scope,
      () => 2,
    );
    reconcileDerivedEdges(
      dbFull,
      "v1",
      computeKnnEdges(dbFull, "v1", { k: 1 }),
      ["similar_to"],
      () => 2,
    );
    expect(finalKeys(dbDelta)).toEqual(finalKeys(dbFull));
    expect(finalKeys(dbDelta)).toContain("N.md-X.md");
  });

  it("stays CLOSED under existing edges: a widened-in note drags its own edge-neighbours in too", () => {
    // The trap this guards is subtle and cost me a real regression before it was written down.
    //
    // reconcileDerivedEdgesScoped deletes any edge that TOUCHES scope but is absent from `desired`.
    // Pulling a discovery candidate C into scope therefore puts every C-edge at risk — including one
    // that C does not itself own, i.e. that exists only because the note on the OTHER end ranks C in
    // its top-k. If that other note is not also a source, it never re-asserts the edge, `desired`
    // omits it, and the scoped delete removes an edge a full recompute would have kept.
    //
    // So widening the scope is not enough: the widened scope must be re-closed over existing edges.
    // Scope is closed 1 hop around the notes this pass PULLED IN — deliberately not transitively.
    // A transitive closure would drag in the whole connected component and destroy the speedup, and it
    // is not required: an untouched note's own ranking can only change if a CHANGED note displaces
    // something in its top-k, which is precisely what the 1-hop rule already covers. This is the same
    // invariant depth THE-486 established for `changed`; THE-533 extends it to the widened set.
    const db = seed();
    phase = "after";
    const scope = knnDiscoveryScope(db, "v1", new Set(["N.md"]), { k: 1 });
    expect(scope.has("X.md")).toBe(true); // pulled in by forward discovery
    expect(scope.has("P.md")).toBe(true); // dragged in because the baseline holds X.md-P.md
    for (const p of knnNeighborScope(db, "v1", new Set(["X.md"]))) {
      expect(scope.has(p)).toBe(true);
    }
  });

  it("empty `changed` still short-circuits with no query — the warm no-op guarantee survives", () => {
    // THE-486 acceptance criterion 1: a zero-change pass must cost no kNN scan at all.
    expect(knnDiscoveryScope(fakeDb(), "v1", new Set(), K)).toEqual(new Set());
  });

  it("still expands over EXISTING edges too — it is a superset of knnNeighborScope, not a replacement", () => {
    // The changed-note case THE-486 already handles must keep working: a note that changed and HAS
    // edges still pulls in its prior edge-neighbours.
    const db = seed();
    phase = "after";
    const neighbor = knnNeighborScope(db, "v1", new Set(["P.md"]));
    const discovery = knnDiscoveryScope(db, "v1", new Set(["P.md"]), K);
    for (const p of neighbor) expect(discovery.has(p)).toBe(true);
  });
});
