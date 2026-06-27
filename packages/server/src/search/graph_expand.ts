import type { Database } from "../db/types";

/**
 * GraphRAG literal walk — THE-233 W-RETRIEVAL port of knowledge-mcp-server's
 * vault_graph_expand (Postgres recursive CTE, migrations 005/011/013) onto the SQLite
 * substrate. Reimplements the *production-default* behavior: an undirected `links_to`
 * walk over vault_edges, bounded by hopLimit, cycle-guarded, shallowest-hop-wins.
 *
 * Scope note (recorded in MERGE-PROGRESS.md): the 013 frontier-leaf *virtual-hop*
 * experiment (THE-135: pull edgeless leaves toward the query/leaf embedding) is NOT
 * ported. It sat at an 80% bridge-recall ceiling through the whole v1.1 ladder, rarely
 * fires once edges are stored forward+reverse (every reached node then has an incident
 * edge), and is an experiment rather than behavior-preserving core. The semantic
 * threshold + RRF fusion live in graph_search.ts (the graph_rrf eval winner).
 *
 * vault_edges is provided by W-SCHEMA at integration; this module only queries it.
 */

export interface ExpansionNode {
  /** Vault-relative note path reached by the walk (hop >= 1). */
  path: string;
  /** Hop distance from the seed (1..hopLimit), shallowest when reachable multiple ways. */
  hop: number;
  /** The note one step closer to the seed on the shallowest chain. */
  predecessor_path: string;
  /** The seed path that initiated this chain. */
  root_seed: string;
  /** Always "links_to" for the literal walk. */
  via_edge_type: string;
  /** Edge provenance carried from vault_edges (e.g. wikilink_forward/reverse). */
  via_edge_provenance: string | null;
  /** Always "literal" here; virtual hops are deferred (see scope note). */
  edge_kind: "literal";
}

interface WalkRow {
  root_seed: string;
  path: string;
  predecessor_path: string;
  via_provenance: string | null;
  hop: number;
}

/**
 * Walk the undirected `links_to` graph from `seedPaths`. Returns one node per
 * (root_seed, reached path) at hop > 0, shallowest hop. Cycle-guarded via a
 * newline-delimited visited set (paths never contain newlines).
 */
export function expandGraphLiteral(
  db: Database,
  seedPaths: string[],
  opts: { hopLimit?: number } = {},
): ExpansionNode[] {
  const hopLimit = opts.hopLimit ?? 2;
  if (seedPaths.length === 0 || hopLimit < 1) return [];

  const rows = db
    .prepare(
      `WITH RECURSIVE
       undirected(source_path, target_path, provenance) AS (
         SELECT source_path, target_path, provenance FROM vault_edges WHERE edge_type = 'links_to'
         UNION ALL
         SELECT target_path, source_path, provenance FROM vault_edges WHERE edge_type = 'links_to'
       ),
       walk(root_seed, current_path, predecessor_path, via_provenance, hop, visited) AS (
         SELECT j.value, j.value, NULL, NULL, 0, char(10) || j.value || char(10)
         FROM json_each(?) j
         UNION ALL
         SELECT w.root_seed, u.target_path, w.current_path, u.provenance, w.hop + 1,
                w.visited || u.target_path || char(10)
         FROM walk w
         JOIN undirected u ON u.source_path = w.current_path
         WHERE w.hop < ? AND instr(w.visited, char(10) || u.target_path || char(10)) = 0
       )
       SELECT root_seed, current_path AS path, predecessor_path, via_provenance, MIN(hop) AS hop
       FROM walk
       WHERE hop > 0
       GROUP BY root_seed, current_path`,
    )
    .all(JSON.stringify(seedPaths), hopLimit) as WalkRow[];

  return rows.map((r) => ({
    path: r.path,
    hop: r.hop,
    predecessor_path: r.predecessor_path,
    root_seed: r.root_seed,
    via_edge_type: "links_to",
    via_edge_provenance: r.via_provenance,
    edge_kind: "literal" as const,
  }));
}
