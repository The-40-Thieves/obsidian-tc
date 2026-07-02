// Wikilink-edge production for GraphRAG — THE-233 W-INGEST. Reconciles the vault_edges
// table (W-SCHEMA) that W-RETRIEVAL's recursive CTE walks, by reusing obsidian-tc's existing
// link parser/resolver (vault/links.ts) rather than porting KMS ingest/edges.ts wholesale.
//
// The graph the walk reads: undirected `links_to`. So a resolved [[wikilink]] / ![[embed]]
// produces a forward row (links_to / wikilink_forward) AND a reverse row (links_to /
// wikilink_reverse); an unresolved link produces a forward-only `unresolved` row (stored but
// never walked). Markdown links and links inside code are excluded — KMS parsed [[ ]] only,
// so this is behavior-preserving. edge_kind is always 'literal' on stored rows (virtual hops
// are query-time only); provenance carries the real parse signal (direction + resolution).
//
// Single-vault: vault_edges has no vault_id (cache.db is SHARED across vaults with logical
// vault_id isolation on most tables — this one predates that). Multi-vault edge isolation
// (vault_id on vault_edges + a scoped
// graph_expand) is an integration follow-up (THE-233).
import type { Database } from "../db/types";
import { buildVaultIndex, type ExtractedLink, resolveTarget } from "../vault/links";

export type EdgeType = "links_to" | "unresolved";
export type EdgeProvenance = "wikilink_forward" | "wikilink_reverse" | "unresolved";

export interface DesiredEdge {
  source_path: string;
  target_path: string;
  edge_type: EdgeType;
  provenance: EdgeProvenance;
}

export interface EdgeReconcileStats {
  desired: number;
  inserted: number;
  deleted: number;
}

const key = (s: string, t: string, type: string): string => `${s}\n${t}\n${type}`;

/**
 * Compute the desired wikilink-layer edge set from per-note extracted links. `notePaths` is
 * the note universe used to resolve link targets (exact/basename, shortest-path-wins).
 */
export function desiredEdges(
  noteLinks: Map<string, ExtractedLink[]>,
  notePaths: string[],
): DesiredEdge[] {
  const index = buildVaultIndex(notePaths);
  const byKey = new Map<string, DesiredEdge>();
  const put = (e: DesiredEdge): void => {
    const k = key(e.source_path, e.target_path, e.edge_type);
    const existing = byKey.get(k);
    // Prefer wikilink_forward over wikilink_reverse when a mutual link yields both.
    if (
      !existing ||
      (existing.provenance === "wikilink_reverse" && e.provenance === "wikilink_forward")
    ) {
      byKey.set(k, e);
    }
  };

  for (const [source, links] of noteLinks) {
    for (const link of links) {
      if (link.inCodeblock) continue;
      if (link.kind !== "wikilink" && link.kind !== "embed") continue;
      const res = resolveTarget(index, link.target);
      if (res.resolved && res.target_path) {
        const target = res.target_path;
        if (target === source) continue; // self-loop guard
        put({
          source_path: source,
          target_path: target,
          edge_type: "links_to",
          provenance: "wikilink_forward",
        });
        put({
          source_path: target,
          target_path: source,
          edge_type: "links_to",
          provenance: "wikilink_reverse",
        });
      } else {
        const target = link.target.trim();
        if (target === "" || target === source) continue;
        put({
          source_path: source,
          target_path: target,
          edge_type: "unresolved",
          provenance: "unresolved",
        });
      }
    }
  }
  return [...byKey.values()];
}

interface EdgeRow {
  source_path: string;
  target_path: string;
  edge_type: string;
}

/**
 * Full-state reconcile of the wikilink-layer (`links_to` / `unresolved`) rows in vault_edges
 * against `desired`. Other edge_types are never touched. Deletes stale wikilink-layer edges
 * (e.g. from removed notes) and inserts new ones; idempotent on re-run.
 */
export function reconcileVaultEdges(
  db: Database,
  desired: DesiredEdge[],
  now: () => number = Date.now,
): EdgeReconcileStats {
  const ts = now();
  const desiredKeys = new Set(desired.map((e) => key(e.source_path, e.target_path, e.edge_type)));
  const current = db
    .prepare(
      "SELECT source_path, target_path, edge_type FROM vault_edges WHERE edge_type IN ('links_to', 'unresolved')",
    )
    .all() as EdgeRow[];
  const currentKeys = new Set(current.map((r) => key(r.source_path, r.target_path, r.edge_type)));

  const del = db.prepare(
    "DELETE FROM vault_edges WHERE source_path = ? AND target_path = ? AND edge_type = ?",
  );
  let deleted = 0;
  for (const r of current) {
    if (!desiredKeys.has(key(r.source_path, r.target_path, r.edge_type))) {
      del.run(r.source_path, r.target_path, r.edge_type);
      deleted += 1;
    }
  }

  const ins = db.prepare(
    "INSERT OR IGNORE INTO vault_edges (source_path, target_path, edge_type, edge_kind, provenance, created_at, updated_at) VALUES (?, ?, ?, 'literal', ?, ?, ?)",
  );
  let inserted = 0;
  for (const e of desired) {
    if (!currentKeys.has(key(e.source_path, e.target_path, e.edge_type))) {
      ins.run(e.source_path, e.target_path, e.edge_type, e.provenance, ts, ts);
      inserted += 1;
    }
  }
  return { desired: desired.length, inserted, deleted };
}
