// Ported from knowledge-mcp-server eval/reachability.ts (retired). Pure wikilink-graph
// reachability probe for failure diagnosis.
//
// graph_search's expansion applies a similarity filter and a per-walk cap, so its output cannot
// answer "was the target reachable in the graph at all". This probe answers exactly that: an
// undirected walk over `links_to` edges with NO semantic filter and NO cap. It walks from each
// golden query's declared seed_paths (the idealized seed set): if a target is unreachable even
// from ideal seeds, no expansion tuning can surface it — the lever is llm_enrichment, not
// hub_noise_filter.
//
// obsidian-tc port: the edge set is read from the `vault_edges` table through the synchronous
// Database wrapper (edge_type='links_to', scoped by vault_id) instead of KMS's Supabase/Postgres
// client, and the probe returns a richer verdict that distinguishes "no wikilink path exists in
// the graph" from "a path exists but lies beyond the expansion horizon" (the no-path-vs-buried
// requirement). The BFS itself is a pure function over an in-memory adjacency Map so it is
// unit-testable without a database.
import type { Database } from "../src/db/types";

/** Undirected adjacency: note path -> set of neighbor paths. */
export type UndirectedGraph = Map<string, Set<string>>;

export interface ReachabilityResult {
  /** At least one target is within `maxHops` undirected hops of some seed. */
  reachable: boolean;
  /** Shortest hop distance from any seed to the nearest reached target (<= maxHops), else null. */
  hops: number | null;
  /** Targets reached within `maxHops`, nearest first. */
  reachedTargets: string[];
  /** Targets connected to a seed at ANY distance (a superset of reachedTargets). A target present
   *  here but ABSENT from reachedTargets means "a path exists but is deeper than maxHops" — the
   *  expansion horizon buried it; a target in NEITHER list means "no wikilink path exists in the
   *  graph at all". This split is what separates unreachable_in_graph from a buried-but-present
   *  target in the failure classifier. */
  reachableAtAnyDistance: string[];
}

// Golden-set paths are Windows-style (KMS-era); normalize both the loaded graph and the probe
// arguments to forward slashes so membership is separator-agnostic (mirrors eval/run.ts `norm`).
const norm = (p: string): string => p.replace(/\\/g, "/");

function addEdge(adj: UndirectedGraph, from: string, to: string): void {
  let set = adj.get(from);
  if (!set) {
    set = new Set<string>();
    adj.set(from, set);
  }
  set.add(to);
}

/**
 * Load the undirected wikilink graph from `vault_edges`.
 *
 * obsidian-tc schema rewrite of KMS's loadVaultGraph: a single SELECT over vault_edges scoped by
 * vault_id with edge_type='links_to' (KMS keyed on a `type` column against a paginated Supabase
 * table). `unresolved` edges point at non-existent notes and cannot reach a real target, so they
 * are correctly excluded by the edge_type filter. Each stored edge is added in BOTH directions so
 * the walk is undirected, matching graph_expand's UNION-ALL reverse leg.
 */
export function loadUndirectedGraph(db: Database, vaultId: string): UndirectedGraph {
  const rows = db
    .prepare(
      "SELECT source_path, target_path FROM vault_edges WHERE vault_id = ? AND edge_type = 'links_to'",
    )
    .all(vaultId) as Array<{ source_path: string; target_path: string }>;
  const adj: UndirectedGraph = new Map();
  for (const row of rows) {
    const s = norm(row.source_path);
    const t = norm(row.target_path);
    if (s === t) continue; // self-loop contributes no reachability
    addEdge(adj, s, t);
    addEdge(adj, t, s);
  }
  return adj;
}

/**
 * Undirected multi-source BFS from `seeds`. Reports which `targets` are reachable within `maxHops`
 * and, separately, which are reachable at ANY distance — the two facts the failure classifier
 * needs to tell "graph has no path" (llm_enrichment) from "graph has a path but expansion buried
 * it" (hub_noise_filter). maxHops=2 matches graph_expand's default `hop < 2` recursion bound
 * (seed -> hop1 -> hop2). Pure: no DB, unit-testable with an in-memory Map.
 */
export function reachableWithin(
  graph: UndirectedGraph,
  seeds: string[],
  targets: string[],
  maxHops: number,
): ReachabilityResult {
  const targetSet = new Set(targets.map(norm));
  // `dist` is the shortest hop distance from ANY seed, computed UNBOUNDED so the any-distance
  // question can be answered; the maxHops cut is applied when the targets are read off below.
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const seed of seeds) {
    const s = norm(seed);
    if (!dist.has(s)) {
      dist.set(s, 0);
      queue.push(s);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];
    if (node === undefined) continue;
    const d = dist.get(node) ?? 0;
    const neighbors = graph.get(node);
    if (!neighbors) continue;
    for (const nb of neighbors) {
      if (!dist.has(nb)) {
        dist.set(nb, d + 1);
        queue.push(nb);
      }
    }
  }
  const within: Array<{ path: string; hops: number }> = [];
  const connected: string[] = [];
  for (const t of targetSet) {
    const d = dist.get(t);
    if (d === undefined) continue;
    connected.push(t);
    if (d <= maxHops) within.push({ path: t, hops: d });
  }
  within.sort((a, b) => a.hops - b.hops);
  const nearest = within[0];
  return {
    reachable: within.length > 0,
    hops: nearest ? nearest.hops : null,
    reachedTargets: within.map((w) => w.path),
    reachableAtAnyDistance: connected,
  };
}

/**
 * Convenience bridge for the classifier: the SET of a query's target_paths that are reachable
 * within `maxHops` of its seeds. `analyzeQuery` consumes this set (KMS passed a raw Set), while
 * `reachableWithin` above keeps the richer verdict for callers that need the no-path-vs-buried
 * distinction.
 */
export function reachableTargetSet(
  graph: UndirectedGraph,
  seeds: string[],
  targets: string[],
  maxHops: number,
): Set<string> {
  return new Set(reachableWithin(graph, seeds, targets, maxHops).reachedTargets);
}
