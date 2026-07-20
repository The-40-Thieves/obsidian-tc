// Unit tests for the pure wikilink reachability probe (eval/reachability.ts): the undirected BFS
// over an in-memory graph (path at k hops / no path / direct edge / disconnected components) and
// the vault_edges loader over an in-memory SQLite DB.
import { describe, expect, it } from "vitest";
import { loadUndirectedGraph, reachableWithin, type UndirectedGraph } from "../eval/reachability";
import { openMemoryDb } from "./helpers";

/** Build an undirected adjacency Map from bidirectional edge pairs. */
function mkGraph(pairs: Array<[string, string]>): UndirectedGraph {
  const g: UndirectedGraph = new Map();
  const add = (a: string, b: string): void => {
    let set = g.get(a);
    if (!set) {
      set = new Set<string>();
      g.set(a, set);
    }
    set.add(b);
  };
  for (const [a, b] of pairs) {
    add(a, b);
    add(b, a);
  }
  return g;
}

describe("reachableWithin (pure BFS)", () => {
  it("finds a direct edge at hop 1", () => {
    const g = mkGraph([["A", "B"]]);
    const r = reachableWithin(g, ["A"], ["B"], 1);
    expect(r.reachable).toBe(true);
    expect(r.hops).toBe(1);
    expect(r.reachedTargets).toEqual(["B"]);
    expect(r.reachableAtAnyDistance).toEqual(["B"]);
  });

  it("finds a target at exactly k hops when maxHops allows it", () => {
    const g = mkGraph([
      ["A", "B"],
      ["B", "C"],
      ["C", "D"],
    ]);
    const r = reachableWithin(g, ["A"], ["D"], 3);
    expect(r.reachable).toBe(true);
    expect(r.hops).toBe(3);
    expect(r.reachedTargets).toEqual(["D"]);
  });

  it("distinguishes 'buried beyond horizon' from 'no path': D exists but maxHops=2 misses it", () => {
    const g = mkGraph([
      ["A", "B"],
      ["B", "C"],
      ["C", "D"],
    ]);
    const r = reachableWithin(g, ["A"], ["D"], 2);
    // The whole point: not reachable within the horizon, but a path DOES exist in the graph.
    expect(r.reachable).toBe(false);
    expect(r.hops).toBe(null);
    expect(r.reachedTargets).toEqual([]);
    expect(r.reachableAtAnyDistance).toEqual(["D"]);
  });

  it("reports no path at all for a truly absent target", () => {
    const g = mkGraph([["A", "B"]]);
    const r = reachableWithin(g, ["A"], ["Z"], 5);
    expect(r.reachable).toBe(false);
    expect(r.hops).toBe(null);
    expect(r.reachedTargets).toEqual([]);
    expect(r.reachableAtAnyDistance).toEqual([]);
  });

  it("reports no path across disconnected components (any distance)", () => {
    const g = mkGraph([
      ["A", "B"],
      ["C", "D"],
    ]);
    const r = reachableWithin(g, ["A"], ["D"], 10);
    expect(r.reachable).toBe(false);
    expect(r.reachableAtAnyDistance).toEqual([]);
  });

  it("returns the reachable subset when only some targets are connected, nearest first", () => {
    const g = mkGraph([
      ["A", "B"],
      ["B", "C"],
    ]);
    const r = reachableWithin(g, ["A"], ["Z", "C", "B"], 2);
    expect(r.reachable).toBe(true);
    expect(r.hops).toBe(1);
    expect(r.reachedTargets).toEqual(["B", "C"]);
    expect(new Set(r.reachableAtAnyDistance)).toEqual(new Set(["B", "C"]));
  });

  it("normalizes Windows-style backslash paths on both sides", () => {
    const g = mkGraph([["dir/a.md", "dir/b.md"]]);
    const r = reachableWithin(g, ["dir\\a.md"], ["dir\\b.md"], 1);
    expect(r.reachable).toBe(true);
    expect(r.reachedTargets).toEqual(["dir/b.md"]);
  });
});

describe("loadUndirectedGraph (vault_edges loader)", () => {
  function seedDb(): ReturnType<typeof openMemoryDb> {
    const db = openMemoryDb();
    db.exec(
      `CREATE TABLE vault_edges (source_path TEXT NOT NULL, target_path TEXT NOT NULL,
         edge_type TEXT NOT NULL, edge_kind TEXT NOT NULL DEFAULT 'literal', provenance TEXT,
         vault_id TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
    );
    const ins = (src: string, tgt: string, type: string, vault: string): void => {
      db.prepare(
        "INSERT INTO vault_edges (source_path, target_path, edge_type, vault_id, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)",
      ).run(src, tgt, type, vault);
    };
    ins("a.md", "b.md", "links_to", "main");
    ins("b.md", "c.md", "links_to", "main");
    ins("a.md", "ghost.md", "unresolved", "main"); // wrong edge_type — excluded
    ins("x.md", "y.md", "links_to", "other"); // wrong vault — excluded
    return db;
  }

  it("loads only links_to edges for the requested vault, both directions", () => {
    const g = loadUndirectedGraph(seedDb(), "main");
    // undirected: a<->b, b<->c
    expect(g.get("a.md")).toEqual(new Set(["b.md"]));
    expect(new Set(g.get("b.md"))).toEqual(new Set(["a.md", "c.md"]));
    expect(g.get("c.md")).toEqual(new Set(["b.md"]));
    // excluded rows never appear
    expect(g.has("ghost.md")).toBe(false);
    expect(g.has("x.md")).toBe(false);
  });

  it("drives the BFS end-to-end off the loaded graph", () => {
    const g = loadUndirectedGraph(seedDb(), "main");
    const r = reachableWithin(g, ["a.md"], ["c.md"], 2);
    expect(r.reachable).toBe(true);
    expect(r.hops).toBe(2);
  });
});
