// Derived-edge production for graph densification (graphify spec-donor port). The literal wikilink
// layer (search/edges.ts) holds only human-authored edges, so a multi-hop query whose bridge notes
// are not explicitly linked cannot traverse (the graphify sparsity diagnosis; see
// docs/plans/2026-07-13-graph-densification.md). This module produces DERIVED edges — structural
// (shared frontmatter tags here; vec0 kNN and LLM Pass-3 in later increments) — reconciled into
// vault_edges on their OWN edge_types, so the literal reconcile (reconcileVaultEdges) never touches
// them and this one never touches the literal layer.
//
// Boundaries (docs/plans/2026-07-13-graph-densification.md): derived edges are rebuildable cache,
// never written back into notes as wikilinks (the isnad boundary), and default OFF until measured on
// the multi-hop golden set. Hub exclusion happens at creation time — a tag on too many notes is a
// hub, not a similarity signal (graphify --exclude-hubs).
import type { Database } from "../db/types";
import { blobToFloats, loadVec, vecKnn } from "./vec";

export type DerivedEdgeType = "shared_tag" | "similar_to" | "semantically_similar_to";
export type DerivedEdgeKind = "virtual" | "derived";

export interface DerivedEdge {
  source_path: string;
  target_path: string;
  edge_type: DerivedEdgeType;
  edge_kind: DerivedEdgeKind;
  provenance: string;
  /** Discrete rubric score for inferred edges; null for structural (shared_tag). */
  confidence: number | null;
  /** Hash of the cited source content for the staleness sweep; null when the edge derives from both
   *  endpoints' metadata rather than one source's body (shared_tag). */
  source_fingerprint: string | null;
}

export interface DerivedReconcileStats {
  desired: number;
  inserted: number;
  deleted: number;
}

const key = (s: string, t: string, type: string): string => `${s}\n${t}\n${type}`;

/**
 * Shared-tag co-occurrence edges: notes that share a frontmatter tag get one undirected `shared_tag`
 * edge per pair, stored in canonical path order (the graph walk unions both directions, as it does
 * for links_to). Hub tags — carried by more than `maxTagFanout` notes — emit no edges: a ubiquitous
 * tag (`#project`) is a hub, not a signal, and would emit O(n^2) edges from a single cluster
 * (graphify --exclude-hubs). Singleton tags no-op. Deterministic, free, no egress. `confidence` and
 * `source_fingerprint` are null (structural, and derived from both notes' tag sets, not one body).
 */
export function tagCooccurrenceEdges(
  notesTags: Map<string, string[]>,
  opts: { maxTagFanout?: number } = {},
): DerivedEdge[] {
  const maxTagFanout = opts.maxTagFanout ?? 25;
  const tagToNotes = new Map<string, Set<string>>();
  for (const [path, tags] of notesTags) {
    for (const raw of tags) {
      const t = raw.trim().toLowerCase();
      if (t === "") continue;
      const set = tagToNotes.get(t) ?? new Set<string>();
      set.add(path);
      tagToNotes.set(t, set);
    }
  }
  const byKey = new Map<string, DerivedEdge>();
  for (const notesSet of tagToNotes.values()) {
    // Singletons no-op; hub tags are excluded (fanout guard) before the O(n^2) pairing.
    if (notesSet.size < 2 || notesSet.size > maxTagFanout) continue;
    const notes = [...notesSet].sort();
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        const a = notes[i] as string;
        const b = notes[j] as string;
        const k = key(a, b, "shared_tag");
        if (byKey.has(k)) continue;
        byKey.set(k, {
          source_path: a,
          target_path: b,
          edge_type: "shared_tag",
          edge_kind: "derived",
          provenance: "tag_cooccur",
          confidence: null,
          source_fingerprint: null,
        });
      }
    }
  }
  return [...byKey.values()];
}

interface DerivedRow {
  source_path: string;
  target_path: string;
  edge_type: string;
}

/**
 * Full-state reconcile of the DERIVED layer for `vaultId`, scoped to `edgeTypes`. Mirrors
 * reconcileVaultEdges but only over the given derived edge_types: the literal `links_to`/`unresolved`
 * rows are never selected, deleted, or inserted here. `edgeTypes` MUST be exactly the set this call
 * owns (e.g. ['shared_tag']) so an increment that rebuilds only tag edges cannot delete kNN or LLM
 * edges. Idempotent; a re-run with the same desired set is a no-op.
 */
export function reconcileDerivedEdges(
  db: Database,
  vaultId: string,
  desired: DerivedEdge[],
  edgeTypes: DerivedEdgeType[],
  now: () => number = Date.now,
): DerivedReconcileStats {
  const ts = now();
  const owned = new Set<string>(edgeTypes);
  // A desired edge outside the owned set would let a stale-delete wipe an edge this call is not
  // authoritative over — fail loudly instead.
  for (const e of desired) {
    if (!owned.has(e.edge_type)) {
      throw new Error(`reconcileDerivedEdges: desired edge_type '${e.edge_type}' not in owned set`);
    }
  }
  const placeholders = edgeTypes.map(() => "?").join(", ");
  const desiredKeys = new Set(desired.map((e) => key(e.source_path, e.target_path, e.edge_type)));
  const current = db
    .prepare(
      `SELECT source_path, target_path, edge_type FROM vault_edges WHERE vault_id = ? AND edge_type IN (${placeholders})`,
    )
    .all(vaultId, ...edgeTypes) as DerivedRow[];
  const currentKeys = new Set(current.map((r) => key(r.source_path, r.target_path, r.edge_type)));

  const del = db.prepare(
    "DELETE FROM vault_edges WHERE vault_id = ? AND source_path = ? AND target_path = ? AND edge_type = ?",
  );
  let deleted = 0;
  for (const r of current) {
    if (!desiredKeys.has(key(r.source_path, r.target_path, r.edge_type))) {
      del.run(vaultId, r.source_path, r.target_path, r.edge_type);
      deleted += 1;
    }
  }

  const ins = db.prepare(
    "INSERT OR IGNORE INTO vault_edges (vault_id, source_path, target_path, edge_type, edge_kind, provenance, confidence, source_fingerprint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  let inserted = 0;
  for (const e of desired) {
    if (!currentKeys.has(key(e.source_path, e.target_path, e.edge_type))) {
      ins.run(
        vaultId,
        e.source_path,
        e.target_path,
        e.edge_type,
        e.edge_kind,
        e.provenance,
        e.confidence,
        e.source_fingerprint,
        ts,
        ts,
      );
      inserted += 1;
    }
  }
  return { desired: desired.length, inserted, deleted };
}

export interface KnnNeighbor {
  source_path: string;
  target_path: string;
  /** Cosine similarity in [0,1], higher = closer (1 - vec0 distance). */
  sim: number;
}

/**
 * Aggregate chunk-level nearest-neighbor pairs into note-level `similar_to` edges. A note has many
 * chunks and each chunk has many neighbor chunks, so this collapses to one edge per neighbor NOTE
 * (keeping the strongest chunk-pair similarity), drops self-pairs and anything below `minSim`, and
 * keeps each source note's top `k` neighbors. kNN is directional; the surviving pairs are then stored
 * in canonical path order (max sim wins on a tie) so the undirected walk sees each once. `confidence`
 * carries the cosine similarity; `source_fingerprint` is null (the edge derives from embeddings, which
 * are already content-hash keyed, so the fingerprint sweep is redundant for this kind).
 */
export function knnEdgesFromNeighbors(
  neighbors: KnnNeighbor[],
  opts: { k?: number; minSim?: number } = {},
): DerivedEdge[] {
  const k = opts.k ?? 8;
  const minSim = opts.minSim ?? 0;
  const bySource = new Map<string, Map<string, number>>();
  for (const n of neighbors) {
    if (n.source_path === n.target_path || n.sim < minSim) continue;
    const m = bySource.get(n.source_path) ?? new Map<string, number>();
    const prev = m.get(n.target_path);
    if (prev === undefined || n.sim > prev) m.set(n.target_path, n.sim);
    bySource.set(n.source_path, m);
  }
  const byPair = new Map<string, DerivedEdge>();
  for (const [source, targets] of bySource) {
    const topK = [...targets.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, k);
    for (const [target, sim] of topK) {
      const [a, b] = source < target ? [source, target] : [target, source];
      const pk = key(a, b, "similar_to");
      const confidence = Math.round(sim * 1000) / 1000;
      const existing = byPair.get(pk);
      if (!existing || (existing.confidence ?? 0) < confidence) {
        byPair.set(pk, {
          source_path: a,
          target_path: b,
          edge_type: "similar_to",
          edge_kind: "virtual",
          provenance: "cosine_knn",
          confidence,
          source_fingerprint: null,
        });
      }
    }
  }
  return [...byPair.values()];
}

/**
 * Compute note-level kNN `similar_to` edges over vec_chunks for `vaultId`. For each active chunk
 * embedding, vec0 kNN finds its nearest chunks (the +path aux column rides along free), which map to
 * neighbor NOTES; knnEdgesFromNeighbors collapses those to per-note edges. Requires the sqlite-vec
 * extension (loadVec) + a populated vec_chunks; returns [] when the extension is unavailable
 * (node:sqlite) so indexing degrades cleanly instead of throwing. Over-fetches per chunk (many chunks
 * share a note, plus the self-hit) so k neighbor NOTES survive the note-collapse.
 */
export function computeKnnEdges(
  db: Database,
  vaultId: string,
  opts: { k?: number; minSim?: number } = {},
): DerivedEdge[] {
  const k = opts.k ?? 8;
  const hasVecChunks =
    db.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'vec_chunks'").get() !== undefined;
  if (!loadVec(db) || !hasVecChunks) return [];
  const rows = db
    .prepare(
      "SELECT c.path AS path, e.embedding AS embedding FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE e.is_active = 1 AND c.vault_id = ?",
    )
    .all(vaultId) as Array<{ path: string; embedding: Uint8Array }>;
  const neighbors: KnnNeighbor[] = [];
  for (const row of rows) {
    const vec = [...blobToFloats(row.embedding)];
    const hits = vecKnn(db, vec, k * 4 + 1, vaultId);
    for (const h of hits) {
      if (!h.path || h.path === row.path) continue;
      neighbors.push({ source_path: row.path, target_path: h.path, sim: 1 - h.distance });
    }
  }
  return knnEdgesFromNeighbors(neighbors, opts);
}
