// THE-452 — the tool layer over the persisted graph. The algorithms are verified in
// graph-analytics.test.ts; this pins the three behaviours only the tool layer can get wrong:
// ACL scoping, the betweenness refusal, and the honesty warning travelling with the data.

import type { ToolResult } from "@the-40-thieves/obsidian-tc-shared";
import { describe, expect, it } from "vitest";
import { makeTestVault } from "./m1-helpers";

const NOW = 1_700_000_000_000;

/**
 * `secret` attaches an unreadable leaf to a1.md for the ACL cases. It is OFF for the betweenness
 * assertion: any leaf makes its holder a cut vertex, so with it attached a1.md outranks bridge.md
 * legitimately — a real property of the graph, not a bug. One fixture per claim.
 */
function seedEdges(
  db: ReturnType<typeof makeTestVault>["db"],
  vaultId: string,
  opts: { secret?: boolean } = {},
): void {
  const ins = db.prepare(
    "INSERT INTO vault_edges (vault_id, source_path, target_path, edge_type, edge_kind, provenance, created_at, updated_at) VALUES (?, ?, ?, ?, 'literal', 'wikilink', ?, ?)",
  );
  // Two clusters joined through bridge.md, plus a secret/ note wired into the public side.
  const edges: Array<[string, string, string]> = [
    ["a1.md", "a2.md", "links_to"],
    ["a2.md", "a3.md", "links_to"],
    ["a3.md", "a1.md", "links_to"],
    ["a1.md", "bridge.md", "links_to"],
    ["bridge.md", "b1.md", "links_to"],
    ["b1.md", "b2.md", "links_to"],
    ["b2.md", "b3.md", "links_to"],
    ["b3.md", "b1.md", "links_to"],
    // A leaf, deliberately NOT a second bridge: with two disjoint a->b routes bridge.md would not
    // be the unique cut vertex between the clusters at all.
    ...(opts.secret === false
      ? []
      : ([["a1.md", "secret/hidden.md", "links_to"]] as Array<[string, string, string]>)),
  ];
  for (const [s, t, type] of edges) ins.run(vaultId, s, t, type, NOW, NOW);
}

const data = <T>(r: ToolResult): T => (r as { data: T }).data;

describe("THE-452 graph analytics tools", () => {
  it("ranks by pagerank and reports the graph it measured", async () => {
    const v = makeTestVault();
    seedEdges(v.db, v.id);
    const res = data<{ nodes: number; edges: number; results: Array<{ path: string }> }>(
      await v.call("graph_centrality", { vault: v.id, metric: "pagerank", limit: 5 }),
    );
    expect(res.nodes).toBeGreaterThan(0);
    expect(res.edges).toBe(9);
    expect(res.results.length).toBeLessThanOrEqual(5);
    v.cleanup();
  });

  it("finds the bridge with betweenness — the measure PageRank cannot substitute for", async () => {
    const v = makeTestVault();
    seedEdges(v.db, v.id, { secret: false });
    const res = data<{ results: Array<{ path: string; score: number }> }>(
      await v.call("graph_centrality", { vault: v.id, metric: "betweenness", limit: 3 }),
    );
    expect(res.results[0]?.path).toBe("bridge.md");
    // ...and it tops BRIDGING while PageRank picks someone else — the property that makes this a
    // genuinely different question rather than a proxy for degree.
    const byPagerank = data<{ results: Array<{ path: string }> }>(
      await v.call("graph_centrality", { vault: v.id, metric: "pagerank", limit: 3 }),
    );
    expect(byPagerank.results[0]?.path).not.toBe("bridge.md");
    v.cleanup();
  });

  it("drops an edge whose FAR end is unreadable, not just the unreadable node", async () => {
    // Keeping the near end would still tell the caller that secret/hidden.md exists, and would
    // change everyone else's centrality by leaving a phantom path through it.
    const v = makeTestVault({
      acl: { readPaths: ["a1.md", "a2.md", "a3.md", "b1.md", "b2.md", "b3.md", "bridge.md"] },
    });
    seedEdges(v.db, v.id);
    const res = data<{ edges: number; results: Array<{ path: string }> }>(
      await v.call("graph_centrality", { vault: v.id, metric: "pagerank", limit: 50 }),
    );
    expect(res.results.some((r) => r.path.startsWith("secret/"))).toBe(false);
    expect(res.edges).toBe(8); // the secret/ edge is gone from the graph entirely
    v.cleanup();
  });

  it("carries the modularity warning in the RESULT, not only the description", async () => {
    const v = makeTestVault();
    // A complete graph has no community structure; the tool must say so where a caller reading
    // only the data will see it.
    const ins = v.db.prepare(
      "INSERT INTO vault_edges (vault_id, source_path, target_path, edge_type, edge_kind, provenance, created_at, updated_at) VALUES (?, ?, ?, 'links_to', 'literal', 'wikilink', ?, ?)",
    );
    const nodes = ["n1.md", "n2.md", "n3.md", "n4.md", "n5.md"];
    for (const a of nodes) for (const b of nodes) if (a < b) ins.run(v.id, a, b, NOW, NOW);
    const res = data<{ meaningful: boolean; note?: string; modularity: number }>(
      await v.call("graph_communities", { vault: v.id }),
    );
    expect(res.meaningful).toBe(false);
    expect(res.note).toMatch(/not meaningfully better than chance/);
    v.cleanup();
  });

  it("reports a meaningful partition without the warning", async () => {
    const v = makeTestVault();
    seedEdges(v.db, v.id);
    const res = data<{ meaningful: boolean; note?: string; communities: Array<{ id: number }> }>(
      await v.call("graph_communities", { vault: v.id }),
    );
    expect(res.meaningful).toBe(true);
    expect(res.note).toBeUndefined();
    expect(res.communities.length).toBeGreaterThanOrEqual(2);
    v.cleanup();
  });

  it("is deterministic across calls at the same seed", async () => {
    const v = makeTestVault();
    seedEdges(v.db, v.id);
    const one = data<unknown>(await v.call("graph_communities", { vault: v.id, seed: 9 }));
    const two = data<unknown>(await v.call("graph_communities", { vault: v.id, seed: 9 }));
    expect(two).toEqual(one);
    v.cleanup();
  });

  it("traces a path with the edge type behind each hop", async () => {
    const v = makeTestVault();
    seedEdges(v.db, v.id);
    const res = data<{
      connected: boolean;
      hops: Array<{ from: string; to: string; via: string[] }>;
      length: number | null;
    }>(await v.call("graph_path_between", { vault: v.id, from: "a2.md", to: "b2.md" }));
    expect(res.connected).toBe(true);
    expect(res.hops.map((h) => h.to)).toContain("bridge.md");
    // The rationale is the point of the tool — a bare path is not an explanation.
    expect(res.hops[0]?.via).toContain("links_to");
    v.cleanup();
  });

  it("distinguishes 'not in the graph' from 'not connected'", async () => {
    const v = makeTestVault();
    seedEdges(v.db, v.id);
    const missing = data<{ connected: boolean; from_in_graph: boolean; to_in_graph: boolean }>(
      await v.call("graph_path_between", { vault: v.id, from: "a1.md", to: "unlinked.md" }),
    );
    // An unlinked note and a note in a separate component both answer connected:false; only the
    // presence flags tell the caller which situation they are in.
    expect(missing.connected).toBe(false);
    expect(missing.from_in_graph).toBe(true);
    expect(missing.to_in_graph).toBe(false);
    v.cleanup();
  });

  it("cannot route a path through a note the caller may not read", async () => {
    const v = makeTestVault({
      acl: { readPaths: ["a1.md", "a2.md", "a3.md", "b1.md", "b2.md", "b3.md"] },
    });
    seedEdges(v.db, v.id);
    // bridge.md is denied and it is the only a->b route, so the clusters are disconnected for
    // this caller. A leak here would be a path naming a note the caller cannot see. (The ACL is
    // written as explicit paths, not "b*.md" — that glob also matches bridge.md.)
    const res = data<{ connected: boolean; hops: Array<{ to: string }> }>(
      await v.call("graph_path_between", { vault: v.id, from: "a2.md", to: "b2.md" }),
    );
    expect(res.connected).toBe(false);
    expect(JSON.stringify(res.hops)).not.toContain("secret/");
    v.cleanup();
  });

  it("returns an empty graph rather than failing when there are no edges", async () => {
    const v = makeTestVault();
    const res = data<{ nodes: number; results: unknown[] }>(
      await v.call("graph_centrality", { vault: v.id }),
    );
    expect(res.nodes).toBe(0);
    expect(res.results).toEqual([]);
    v.cleanup();
  });
});
