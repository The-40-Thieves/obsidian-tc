// THE-452 — graph analytics. Verified against structures whose answers are known by construction
// rather than by running the code and blessing whatever it printed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  betweenness,
  buildGraph,
  edgeKey,
  findPath,
  type GraphEdge,
  louvain,
  pageRank,
} from "../src/graph/analytics";

const e = (source: string, target: string): GraphEdge => ({ source, target });

/** Two triangles joined by a single bridge node — the canonical betweenness/community fixture. */
const TWO_TRIANGLES: GraphEdge[] = [
  e("a1", "a2"),
  e("a2", "a3"),
  e("a3", "a1"),
  e("b1", "b2"),
  e("b2", "b3"),
  e("b3", "b1"),
  e("a1", "bridge"),
  e("bridge", "b1"),
];

describe("THE-452 buildGraph", () => {
  it("sorts nodes and drops self-links", () => {
    const g = buildGraph([e("z.md", "a.md"), e("a.md", "a.md")]);
    expect(g.nodes).toEqual(["a.md", "z.md"]);
    // A self-link carries no structure and would inflate degree and PageRank alike.
    expect(g.out[g.index.get("a.md") as number]).toEqual([]);
  });

  it("builds undirected adjacency from directed edges", () => {
    const g = buildGraph([e("a", "b")]);
    expect(g.undirected[g.index.get("b") as number]).toEqual([g.index.get("a")]);
  });
});

describe("THE-452 pageRank", () => {
  it("ranks the target of many links above its sources", () => {
    const g = buildGraph([e("a", "hub"), e("b", "hub"), e("c", "hub")]);
    const ranked = pageRank(g);
    expect(ranked[0]?.path).toBe("hub");
  });

  it("sums to 1 — dangling nodes must not leak rank mass", () => {
    // "dead" has no outbound links; without redistribution its mass vanishes each iteration and
    // the vector silently stops being a probability distribution.
    const g = buildGraph([e("a", "b"), e("b", "dead")]);
    const total = pageRank(g).reduce((s, r) => s + r.score, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it("gives every node equal rank on a symmetric cycle", () => {
    const g = buildGraph([e("a", "b"), e("b", "c"), e("c", "a")]);
    const scores = pageRank(g).map((r) => r.score);
    for (const s of scores) expect(s).toBeCloseTo(1 / 3, 6);
  });

  it("filters the OUTPUT by minIncomingLinks without changing the scores", () => {
    const g = buildGraph([e("a", "hub"), e("b", "hub"), e("c", "lonely")]);
    const all = pageRank(g);
    const filtered = pageRank(g, { minIncomingLinks: 2 });
    expect(filtered.map((r) => r.path)).toEqual(["hub"]);
    // The surviving score is identical — excluding a node from the COMPUTATION would redistribute
    // its mass and make a display filter into a silent ranking change.
    const hubAll = all.find((r) => r.path === "hub")?.score;
    expect(filtered[0]?.score).toBe(hubAll);
  });

  it("is deterministic and empty-safe", () => {
    const g = buildGraph(TWO_TRIANGLES);
    expect(pageRank(g)).toEqual(pageRank(g));
    expect(pageRank(buildGraph([]))).toEqual([]);
  });
});

describe("THE-452 betweenness", () => {
  it("scores the single bridge node highest — a different question from PageRank", () => {
    const g = buildGraph(TWO_TRIANGLES);
    const bridging = betweenness(g);
    expect(bridging[0]?.path).toBe("bridge");
    // The bridge has only two links; a measure that merely tracked degree would not find it.
    expect((g.undirected[g.index.get("bridge") as number] as number[]).length).toBe(2);
  });

  it("scores every node 0 on a complete triangle (no node is ever on another's only path)", () => {
    const g = buildGraph([e("a", "b"), e("b", "c"), e("c", "a")]);
    for (const r of betweenness(g)) expect(r.score).toBeCloseTo(0, 9);
  });

  it("normalizes into [0,1]", () => {
    for (const r of betweenness(buildGraph(TWO_TRIANGLES))) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });
});

describe("THE-452 louvain", () => {
  it("separates two triangles and reports the partition as meaningful", () => {
    const { communities, modularity, meaningful } = louvain(buildGraph(TWO_TRIANGLES));
    expect(communities.length).toBeGreaterThanOrEqual(2);
    const of = (p: string) => communities.find((c) => c.paths.includes(p))?.id;
    expect(of("a2")).toBe(of("a3"));
    expect(of("b2")).toBe(of("b3"));
    expect(of("a2")).not.toBe(of("b2"));
    expect(modularity).toBeGreaterThan(0.3);
    expect(meaningful).toBe(true);
  });

  it("is deterministic across runs at the same seed", () => {
    const g = buildGraph(TWO_TRIANGLES);
    // A partition that changes between two runs over an unchanged vault is unusable for the
    // "what is my vault's structure" question these tools exist to answer.
    expect(louvain(g, { seed: 7 })).toEqual(louvain(g, { seed: 7 }));
  });

  it("reports meaningful=false when the structure is not there", () => {
    // A complete graph has no community structure; modularity near 0 must not be dressed up as
    // "here are your vault's topics".
    const complete: GraphEdge[] = [];
    const nodes = ["a", "b", "c", "d", "e"];
    for (const x of nodes) for (const y of nodes) if (x < y) complete.push(e(x, y));
    const res = louvain(buildGraph(complete));
    expect(res.modularity).toBeLessThan(0.3);
    expect(res.meaningful).toBe(false);
  });

  it("handles an edgeless graph without claiming structure", () => {
    const res = louvain(buildGraph([]));
    expect(res.communities).toEqual([]);
    expect(res.meaningful).toBe(false);
  });

  it("orders communities densest-first with stable ids", () => {
    const res = louvain(buildGraph(TWO_TRIANGLES));
    const sizes = res.communities.map((c) => c.paths.length);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
    expect(res.communities.map((c) => c.id)).toEqual(res.communities.map((_, i) => i));
  });
});

describe("THE-452 findPath", () => {
  const g = buildGraph(TWO_TRIANGLES);

  it("traces a shortest path across the bridge", () => {
    const path = findPath(g, "a2", "b2");
    expect(path).not.toBeNull();
    const chain = ["a2", ...(path ?? []).map((h) => h.to)];
    expect(chain[0]).toBe("a2");
    expect(chain.at(-1)).toBe("b2");
    expect(chain).toContain("bridge");
  });

  it("returns an empty path for a note to itself, not null", () => {
    // [] means "connected, zero hops"; null means "not connected". Collapsing them would make a
    // note look disconnected from itself.
    expect(findPath(g, "a1", "a1")).toEqual([]);
  });

  it("returns null when either endpoint is not in the graph", () => {
    expect(findPath(g, "a1", "nowhere.md")).toBeNull();
    expect(findPath(g, "nowhere.md", "a1")).toBeNull();
  });

  it("returns null when genuinely disconnected", () => {
    const split = buildGraph([e("x", "y"), e("p", "q")]);
    expect(findPath(split, "x", "q")).toBeNull();
  });

  it("directed mode answers the narrower link-following question", () => {
    const oneWay = buildGraph([e("a", "b")]);
    expect(findPath(oneWay, "a", "b", { directed: true })).toHaveLength(1);
    // Undirected finds it (a reader follows a backlink); directed does not.
    expect(findPath(oneWay, "b", "a", { directed: true })).toBeNull();
    expect(findPath(oneWay, "b", "a")).toHaveLength(1);
  });

  it("attaches the per-hop rationale when edge types are supplied", () => {
    const types = new Map([[edgeKey("a", "b"), ["links_to"]]]);
    const hops = findPath(buildGraph([e("a", "b")]), "a", "b", { edgeTypes: types });
    expect(hops?.[0]?.via).toEqual(["links_to"]);
  });
});

describe("THE-452 analytics are NOT the ranker", () => {
  it("no retrieval module imports the analytics", () => {
    // The ticket's central warning: PageRank correlates with in-degree, which this codebase
    // deliberately SUPPRESSES, so wiring it in as a positive prior is self-contradictory. Asserted
    // structurally rather than trusted to reviewer memory.
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const files = execFileSync(
      "git",
      ["ls-files", "packages/server/src/search/*.ts", "packages/server/src/search/**/*.ts"],
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(20); // an empty scan must not pass vacuously
    const offenders = files.filter((f) =>
      readFileSync(join(root, f), "utf8").includes("graph/analytics"),
    );
    expect(offenders).toEqual([]);
  });
});
