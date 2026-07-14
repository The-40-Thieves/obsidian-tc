import type { Database } from "../db/types";

/**
 * GraphRAG walk — THE-233 W-RETRIEVAL port of knowledge-mcp-server's vault_graph_expand (Postgres
 * recursive CTE) onto SQLite. The production default is an undirected `links_to` walk over vault_edges,
 * bounded by hopLimit, cycle-guarded, shallowest-hop-wins.
 *
 * Densification (docs/plans/2026-07-13-graph-densification.md): when `includeDerived` is set, the walk
 * ALSO crosses derived edges (similar_to = vec0 kNN, shared_tag = tag co-occurrence). Each reached node
 * carries the edge_kind of its shallowest arrival so graph_search can down-weight expansion reached via
 * a soft edge (annotate, not gate). Default OFF -> byte-for-byte the historical literal walk. This
 * supersedes the deferred THE-135 frontier-leaf virtual-hop: stored kNN edges replace the query-time
 * pull, and the measurement gate (multi-hop golden set) decides whether it flips on.
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
  /** Edge type of the shallowest arrival: "links_to" | "similar_to" | "shared_tag". */
  via_edge_type: string;
  /** Edge provenance carried from vault_edges (wikilink_forward/reverse, cosine_knn, tag_cooccur). */
  via_edge_provenance: string | null;
  /** Edge kind of the shallowest arrival: "literal" (authored) or "virtual"/"derived" (densified). */
  edge_kind: "literal" | "virtual" | "derived";
}

interface WalkRow {
  root_seed: string;
  path: string;
  predecessor_path: string;
  via_provenance: string | null;
  via_edge_type: string;
  via_edge_kind: "literal" | "virtual" | "derived" | null;
  hop: number;
}

const DERIVED_EDGE_TYPES = ["similar_to", "shared_tag", "semantically_similar_to"];

/**
 * Walk the undirected edge graph from `seedPaths`, scoped to `opts.vaultId`. Returns one node per
 * (root_seed, reached path) at hop > 0, shallowest hop. Cycle-guarded via a newline-delimited visited
 * set (paths never contain newlines). One MIN(hop) aggregate lets the bare columns
 * (predecessor/provenance/type/kind) take the shallowest-arrival row's values (SQLite bare-column rule).
 */
export function expandGraphLiteral(
  db: Database,
  seedPaths: string[],
  opts: { vaultId: string; hopLimit?: number; includeDerived?: boolean },
): ExpansionNode[] {
  const hopLimit = opts.hopLimit ?? 2;
  if (seedPaths.length === 0 || hopLimit < 1) return [];

  // links_to always; derived types join only under includeDerived, so the default is the historical
  // literal walk unchanged.
  const edgeTypes = opts.includeDerived ? ["links_to", ...DERIVED_EDGE_TYPES] : ["links_to"];
  const inList = edgeTypes.map(() => "?").join(", ");

  const rows = db
    .prepare(
      `WITH RECURSIVE
       undirected(source_path, target_path, edge_type, edge_kind, provenance) AS (
         SELECT source_path, target_path, edge_type, edge_kind, provenance FROM vault_edges
           WHERE vault_id = ? AND edge_type IN (${inList})
         UNION ALL
         SELECT target_path, source_path, edge_type, edge_kind, provenance FROM vault_edges
           WHERE vault_id = ? AND edge_type IN (${inList})
       ),
       walk(root_seed, current_path, predecessor_path, via_type, via_kind, via_provenance, hop, visited) AS (
         SELECT j.value, j.value, NULL, NULL, NULL, NULL, 0, char(10) || j.value || char(10)
         FROM json_each(?) j
         UNION ALL
         SELECT w.root_seed, u.target_path, w.current_path, u.edge_type, u.edge_kind, u.provenance,
                w.hop + 1, w.visited || u.target_path || char(10)
         FROM walk w
         JOIN undirected u ON u.source_path = w.current_path
         WHERE w.hop < ? AND instr(w.visited, char(10) || u.target_path || char(10)) = 0
       )
       SELECT root_seed, current_path AS path, predecessor_path, via_provenance,
              via_type AS via_edge_type, via_kind AS via_edge_kind, MIN(hop) AS hop
       FROM walk
       WHERE hop > 0
       GROUP BY root_seed, current_path`,
    )
    .all(
      opts.vaultId,
      ...edgeTypes,
      opts.vaultId,
      ...edgeTypes,
      JSON.stringify(seedPaths),
      hopLimit,
    ) as WalkRow[];

  return rows.map((r) => ({
    path: r.path,
    hop: r.hop,
    predecessor_path: r.predecessor_path,
    root_seed: r.root_seed,
    via_edge_type: r.via_edge_type,
    via_edge_provenance: r.via_provenance,
    edge_kind: r.via_edge_kind ?? "literal",
  }));
}
