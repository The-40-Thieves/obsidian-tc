// THE-452 — graph analytics over the persisted note graph. Pure functions, no DB, no dependencies.
//
// CRITICAL FRAMING: these are NEW CAPABILITIES, NOT better retrieval, and nothing here may be wired
// into ranking. As ranking priors they would likely LOSE: PageRank correlates with in-degree, which
// this codebase deliberately SUPPRESSES (hub suppression, THE-401's smooth 1/(1+(deg/hubMu)^gamma)
// term), so adding it back as a positive prior is self-contradictory. Louvain-based diversification
// overlaps the MMR/cluster diversification THE-73/THE-393 already ship. The source project keeps
// these out of its own retrieval path too. `graph-analytics.test.ts` greps `search/` and fails if
// any retrieval module imports this file.
//
// Determinism is a requirement, not a nicety: a community partition that changes between two runs
// over an unchanged vault is unusable for the "what changed in my vault" question these tools
// exist to answer. Louvain's node order is therefore driven by a SEEDED PRNG, and every tie
// throughout this file breaks on path string order.

/** A directed edge between two vault-relative note paths. */
export interface GraphEdge {
  source: string;
  target: string;
}

export interface ScoredNode {
  path: string;
  score: number;
}

/** Adjacency built once and shared by the algorithms below. Nodes are sorted for determinism. */
export interface Graph {
  nodes: string[];
  index: Map<string, number>;
  /** out[i] = indices i links TO. */
  out: number[][];
  /** in_[i] = indices that link TO i. */
  in_: number[][];
  /** Undirected neighbour sets, deduped — Louvain and betweenness treat links as connections. */
  undirected: number[][];
}

export function buildGraph(edges: GraphEdge[]): Graph {
  const nodeSet = new Set<string>();
  for (const e of edges) {
    nodeSet.add(e.source);
    nodeSet.add(e.target);
  }
  const nodes = [...nodeSet].sort();
  const index = new Map(nodes.map((n, i) => [n, i]));
  const out: number[][] = nodes.map(() => []);
  const in_: number[][] = nodes.map(() => []);
  const undirectedSets: Array<Set<number>> = nodes.map(() => new Set());
  for (const e of edges) {
    const s = index.get(e.source);
    const t = index.get(e.target);
    if (s === undefined || t === undefined || s === t) continue; // self-links carry no structure
    out[s]?.push(t);
    in_[t]?.push(s);
    undirectedSets[s]?.add(t);
    undirectedSets[t]?.add(s);
  }
  return {
    nodes,
    index,
    out,
    in_,
    undirected: undirectedSets.map((s) => [...s].sort((a, b) => a - b)),
  };
}

/**
 * PageRank by power iteration. Damping 0.85, the standard value.
 *
 * `minIncomingLinks` is the noise filter the ticket calls for: a note with fewer than this many
 * inbound links is EXCLUDED FROM THE RESULT, not from the computation. Excluding it from the
 * computation would redistribute its mass and change everyone else's score, which would make the
 * filter a silent ranking change rather than a display cut.
 *
 * Dangling nodes (no outbound links) would otherwise leak rank mass out of the system; their mass
 * is redistributed uniformly each iteration, which is what keeps the vector summing to 1.
 */
export function pageRank(
  graph: Graph,
  opts: {
    damping?: number;
    iterations?: number;
    tolerance?: number;
    minIncomingLinks?: number;
  } = {},
): ScoredNode[] {
  const d = opts.damping ?? 0.85;
  const maxIter = opts.iterations ?? 100;
  const tol = opts.tolerance ?? 1e-8;
  const minIn = opts.minIncomingLinks ?? 0;
  const n = graph.nodes.length;
  if (n === 0) return [];

  let rank = new Array<number>(n).fill(1 / n);
  for (let iter = 0; iter < maxIter; iter++) {
    const next = new Array<number>(n).fill(0);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      const outs = graph.out[i] as number[];
      if (outs.length === 0) {
        dangling += rank[i] as number;
        continue;
      }
      const share = (rank[i] as number) / outs.length;
      for (const j of outs) next[j] = (next[j] as number) + share;
    }
    const base = (1 - d) / n + (d * dangling) / n;
    let delta = 0;
    for (let i = 0; i < n; i++) {
      const v = base + d * (next[i] as number);
      delta += Math.abs(v - (rank[i] as number));
      next[i] = v;
    }
    rank = next;
    if (delta < tol) break;
  }

  return graph.nodes
    .map((path, i) => ({ path, score: rank[i] as number }))
    .filter((_, i) => (graph.in_[i] as number[]).length >= minIn)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

/**
 * Betweenness centrality — Brandes' algorithm on the UNDIRECTED graph, normalized to [0,1].
 *
 * This is the "bridging" measure: a note with high betweenness sits on many shortest paths between
 * other notes, which is a genuinely different question from PageRank's "many things point here".
 * A hub index page scores high on PageRank; a note that is the ONLY link between two otherwise
 * disconnected topics scores high here and may have very few links.
 *
 * O(V*E). Callers cap the graph size — see the tool layer.
 */
export function betweenness(graph: Graph): ScoredNode[] {
  const n = graph.nodes.length;
  const score = new Array<number>(n).fill(0);
  for (let s = 0; s < n; s++) {
    const stack: number[] = [];
    const preds: number[][] = Array.from({ length: n }, () => []);
    const sigma = new Array<number>(n).fill(0);
    const dist = new Array<number>(n).fill(-1);
    sigma[s] = 1;
    dist[s] = 0;
    const queue: number[] = [s];
    let head = 0;
    while (head < queue.length) {
      const v = queue[head++] as number;
      stack.push(v);
      for (const w of graph.undirected[v] as number[]) {
        if ((dist[w] as number) < 0) {
          dist[w] = (dist[v] as number) + 1;
          queue.push(w);
        }
        if (dist[w] === (dist[v] as number) + 1) {
          sigma[w] = (sigma[w] as number) + (sigma[v] as number);
          preds[w]?.push(v);
        }
      }
    }
    const delta = new Array<number>(n).fill(0);
    while (stack.length > 0) {
      const w = stack.pop() as number;
      for (const v of preds[w] as number[]) {
        delta[v] =
          (delta[v] as number) +
          ((sigma[v] as number) / (sigma[w] as number)) * (1 + (delta[w] as number));
      }
      if (w !== s) score[w] = (score[w] as number) + (delta[w] as number);
    }
  }
  // Undirected Brandes walks every pair from BOTH ends, so the raw score is twice the pair
  // count; the pair count itself is (n-1)(n-2)/2. Halving and dividing by that is a single
  // division by (n-1)(n-2) — getting this wrong produces scores above 1, which the test caught.
  const norm = n > 2 ? 1 / ((n - 1) * (n - 2)) : 0;
  return graph.nodes
    .map((path, i) => ({ path, score: (score[i] as number) * norm }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

/** Mulberry32 — the same seeded PRNG the perf harness uses. Deterministic partitions require it. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Community {
  id: number;
  paths: string[];
}

export interface CommunityResult {
  communities: Community[];
  modularity: number;
  /**
   * THE-452's honesty warning, lifted deliberately: below ~0.3 the partition is not meaningfully
   * better than chance, and presenting it as "your vault's topics" would be inventing structure.
   * The caller is told, rather than left to infer it from a number they may not know how to read.
   */
  meaningful: boolean;
}

/**
 * Louvain community detection (one level of modularity optimisation, repeated to convergence) on
 * the undirected graph. Node visit order is drawn from a seeded PRNG so two runs over an unchanged
 * vault produce an identical partition — without that, "which community is this note in" changes
 * answer between calls and the tool is unusable for tracking vault structure over time.
 */
export function louvain(
  graph: Graph,
  opts: { seed?: number; maxPasses?: number } = {},
): CommunityResult {
  const n = graph.nodes.length;
  if (n === 0) return { communities: [], modularity: 0, meaningful: false };
  const rnd = mulberry32(opts.seed ?? 42);
  const maxPasses = opts.maxPasses ?? 20;

  const degree = graph.undirected.map((nb) => nb.length);
  const m2 = degree.reduce((a, b) => a + b, 0); // 2m
  if (m2 === 0) {
    // No edges: every note is its own community and modularity is undefined, not 0-and-fine.
    return {
      communities: graph.nodes.map((p, i) => ({ id: i, paths: [p] })),
      modularity: 0,
      meaningful: false,
    };
  }

  const community = graph.nodes.map((_, i) => i);
  const totalDegree = [...degree]; // sum of degrees of nodes in each community

  const order = graph.nodes.map((_, i) => i);
  // Fisher-Yates with the seeded PRNG — order affects the local optimum Louvain lands in, so it
  // must be reproducible rather than merely arbitrary.
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = order[i] as number;
    order[i] = order[j] as number;
    order[j] = tmp;
  }

  for (let pass = 0; pass < maxPasses; pass++) {
    let moved = false;
    for (const v of order) {
      const own = community[v] as number;
      const deg = degree[v] as number;
      // Weight from v into each neighbouring community.
      const links = new Map<number, number>();
      for (const w of graph.undirected[v] as number[]) {
        const c = community[w] as number;
        links.set(c, (links.get(c) ?? 0) + 1);
      }
      totalDegree[own] = (totalDegree[own] as number) - deg;

      let bestC = own;
      let bestGain = (links.get(own) ?? 0) - ((totalDegree[own] as number) * deg) / m2;
      for (const [c, k] of [...links.entries()].sort((a, b) => a[0] - b[0])) {
        if (c === own) continue;
        const gain = k - ((totalDegree[c] as number) * deg) / m2;
        if (gain > bestGain) {
          bestGain = gain;
          bestC = c;
        }
      }
      totalDegree[bestC] = (totalDegree[bestC] as number) + deg;
      if (bestC !== own) {
        community[v] = bestC;
        moved = true;
      }
    }
    if (!moved) break;
  }

  // Modularity Q = sum_c [ e_c/m - (a_c/2m)^2 ] over the final partition.
  const inside = new Map<number, number>();
  const tot = new Map<number, number>();
  for (let v = 0; v < n; v++) {
    const c = community[v] as number;
    tot.set(c, (tot.get(c) ?? 0) + (degree[v] as number));
    for (const w of graph.undirected[v] as number[]) {
      if ((community[w] as number) === c) inside.set(c, (inside.get(c) ?? 0) + 1);
    }
  }
  let q = 0;
  for (const [c, twoE] of inside) q += twoE / m2 - ((tot.get(c) ?? 0) / m2) ** 2;
  for (const [c, a] of tot) if (!inside.has(c)) q -= (a / m2) ** 2;

  const byCommunity = new Map<number, string[]>();
  for (let v = 0; v < n; v++) {
    const c = community[v] as number;
    const list = byCommunity.get(c) ?? [];
    list.push(graph.nodes[v] as string);
    byCommunity.set(c, list);
  }
  // Renumber densest-first so ids are stable and readable rather than internal node indices.
  const communities = [...byCommunity.values()]
    .map((paths) => paths.sort())
    .sort((a, b) => b.length - a.length || (a[0] ?? "").localeCompare(b[0] ?? ""))
    .map((paths, id) => ({ id, paths }));

  return { communities, modularity: q, meaningful: q >= 0.3 };
}

/**
 * Key for the optional per-hop edge-type map. Length-prefixed so it is provably injective: a plain
 * `${a} ${b}` join collides whenever a path legitimately contains the separator, and a separator
 * chosen to be "unlikely" is a bug waiting for the one vault that uses it. Exported so callers
 * build the map the same way rather than guessing the format.
 */
export function edgeKey(from: string, to: string): string {
  return `${from.length}:${from}${to}`;
}

export interface PathHop {
  from: string;
  to: string;
  /** Why this hop exists — the edge types joining the two notes, for a human-readable trace. */
  via: string[];
}

/**
 * Shortest path between two notes, with a per-hop rationale.
 *
 * Undirected by default: "how is A connected to B" is a question about the note graph as a reader
 * navigates it, and a reader follows a backlink as readily as a link. `directed: true` answers the
 * narrower "can I get from A to B following links only" question.
 *
 * BFS over the neighbour lists (which are sorted), so among equal-length paths the returned one is
 * deterministic rather than dependent on insertion order.
 */
export function findPath(
  graph: Graph,
  from: string,
  to: string,
  opts: { directed?: boolean; edgeTypes?: Map<string, string[]> } = {},
): PathHop[] | null {
  const s = graph.index.get(from);
  const t = graph.index.get(to);
  if (s === undefined || t === undefined) return null;
  if (s === t) return [];

  const adjacency = opts.directed ? graph.out : graph.undirected;
  const prev = new Array<number>(graph.nodes.length).fill(-1);
  const seen = new Array<boolean>(graph.nodes.length).fill(false);
  seen[s] = true;
  const queue = [s];
  let head = 0;
  while (head < queue.length) {
    const v = queue[head++] as number;
    if (v === t) break;
    for (const w of adjacency[v] as number[]) {
      if (seen[w]) continue;
      seen[w] = true;
      prev[w] = v;
      queue.push(w);
    }
  }
  if (!seen[t]) return null;

  const chain: number[] = [];
  for (let at = t; at !== -1; at = prev[at] as number) chain.push(at);
  chain.reverse();

  const hops: PathHop[] = [];
  for (let i = 0; i + 1 < chain.length; i++) {
    const a = graph.nodes[chain[i] as number] as string;
    const b = graph.nodes[chain[i + 1] as number] as string;
    hops.push({
      from: a,
      to: b,
      via: opts.edgeTypes?.get(edgeKey(a, b)) ?? opts.edgeTypes?.get(edgeKey(b, a)) ?? [],
    });
  }
  return hops;
}
