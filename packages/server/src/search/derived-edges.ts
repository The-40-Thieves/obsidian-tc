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
  /** Content hash of the edge's source material, RECORDED for a future staleness sweep. No sweep exists
   *  yet: nothing compares this against current note content today, so an edge does NOT self-flag as
   *  stale — a re-run simply refreshes it (upsert). Null for edges derived from metadata rather than
   *  note bodies (shared_tag, kNN). */
  source_fingerprint: string | null;
}

export interface DerivedReconcileStats {
  desired: number;
  inserted: number;
  /** Existing edges whose confidence / fingerprint / provenance were REFRESHED by the upsert. */
  updated: number;
  deleted: number;
}

const key = (s: string, t: string, type: string): string => `${s}\n${t}\n${type}`;

// THE-486: shared body for tagCooccurrenceEdges (full) and tagCooccurrenceEdgesForNotes (delta). A
// null `scope` means "unfiltered" (the original full-recompute behaviour); a non-null scope drops any
// tag whose note-set does not touch it at all, and any pair where NEITHER endpoint is in it — pairs
// entirely among untouched notes are assumed already correct (see tagCooccurrenceEdgesForNotes).
function buildTagCooccurrenceEdges(
  notesTags: Map<string, string[]>,
  maxTagFanout: number,
  scope: ReadonlySet<string> | null,
): DerivedEdge[] {
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
    if (scope !== null) {
      let touchesScope = false;
      for (const p of notesSet) {
        if (scope.has(p)) {
          touchesScope = true;
          break;
        }
      }
      if (!touchesScope) continue;
    }
    const notes = [...notesSet].sort();
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        const a = notes[i] as string;
        const b = notes[j] as string;
        if (scope !== null && !scope.has(a) && !scope.has(b)) continue;
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
  return buildTagCooccurrenceEdges(notesTags, opts.maxTagFanout ?? 25, null);
}

/**
 * THE-486 delta counterpart to tagCooccurrenceEdges: `notesTags` must still be the FULL current tag
 * map (a tag's fanout count and its pairing both need the true note set), but a pair is only emitted
 * when at least one endpoint is in `scope`. Pairs entirely among untouched notes are assumed already
 * correct — their tag memberships did not change this pass, so neither did their edge. `scope` empty
 * is a clean no-op ([]), not a full recompute. Pair with tagCooccurrenceScope, which builds the scope
 * a tag-set change actually requires (every note sharing the OLD or NEW tags, not just the changed
 * note itself).
 */
export function tagCooccurrenceEdgesForNotes(
  notesTags: Map<string, string[]>,
  scope: ReadonlySet<string>,
  opts: { maxTagFanout?: number } = {},
): DerivedEdge[] {
  if (scope.size === 0) return [];
  return buildTagCooccurrenceEdges(notesTags, opts.maxTagFanout ?? 25, scope);
}

/**
 * THE-486: which of `candidates` actually had their (normalized) tag SET change — ignores order,
 * case, and whitespace, matching tagCooccurrenceEdges' own normalization, so a case-only rewrite (or
 * a reordered frontmatter list) never manufactures a false delta. A candidate absent from `newTags`
 * (a note deleted this pass) is treated as having no tags now — correctly flags it as changed when it
 * used to carry any.
 */
export function notesWithTagChanges(
  oldTags: Map<string, string[]>,
  newTags: Map<string, string[]>,
  candidates: Iterable<string>,
): Set<string> {
  const norm = (tags: string[]): Set<string> =>
    new Set(tags.map((t) => t.trim().toLowerCase()).filter((t) => t !== ""));
  const out = new Set<string>();
  for (const path of candidates) {
    const before = norm(oldTags.get(path) ?? []);
    const after = norm(newTags.get(path) ?? []);
    let same = before.size === after.size;
    if (same) for (const t of before) if (!after.has(t)) same = false;
    if (!same) out.add(path);
  }
  return out;
}

/**
 * THE-486: the scope a tag-cooccurrence delta must cover — every note in `changed`, PLUS every note
 * sharing any tag `changed` carried BEFORE or AFTER this pass. A note whose tags changed affects
 * co-occurrence for every note sharing the old tags (loses an edge) and every note sharing the new
 * tags (gains one) — not only its own direct edges, so the scope reads both snapshots. `changed`
 * empty short-circuits with no scan.
 */
export function tagCooccurrenceScope(
  oldTags: Map<string, string[]>,
  newTags: Map<string, string[]>,
  changed: ReadonlySet<string>,
): Set<string> {
  const scope = new Set<string>(changed);
  if (changed.size === 0) return scope;
  const relevantTags = new Set<string>();
  for (const path of changed) {
    for (const t of oldTags.get(path) ?? []) relevantTags.add(t.trim().toLowerCase());
    for (const t of newTags.get(path) ?? []) relevantTags.add(t.trim().toLowerCase());
  }
  relevantTags.delete("");
  if (relevantTags.size === 0) return scope;
  for (const map of [oldTags, newTags]) {
    for (const [path, tags] of map) {
      for (const raw of tags) {
        if (relevantTags.has(raw.trim().toLowerCase())) {
          scope.add(path);
          break;
        }
      }
    }
  }
  return scope;
}

interface DerivedRow {
  source_path: string;
  target_path: string;
  edge_type: string;
}

// THE-486: shared body for reconcileDerivedEdges (full) and reconcileDerivedEdgesScoped (delta). A
// null `scope` reconciles every row of `edgeTypes` for the vault (the original full-state behaviour);
// a non-null scope only reads/deletes rows where at least one endpoint is in it, and upserts ONLY
// `desired` (which the scoped caller must already have restricted to scope-touching edges — see the
// guard in reconcileDerivedEdgesScoped). Edges entirely outside `scope` are never read or written.
function reconcileDerivedEdgesCore(
  db: Database,
  vaultId: string,
  desired: DerivedEdge[],
  edgeTypes: DerivedEdgeType[],
  scope: ReadonlySet<string> | null,
  now: () => number,
): DerivedReconcileStats {
  const ts = now();
  const placeholders = edgeTypes.map(() => "?").join(", ");
  const desiredKeys = new Set(desired.map((e) => key(e.source_path, e.target_path, e.edge_type)));
  const scopeClause =
    scope !== null
      ? ` AND (source_path IN (${[...scope].map(() => "?").join(", ")}) OR target_path IN (${[...scope].map(() => "?").join(", ")}))`
      : "";
  const scopeParams = scope !== null ? [...scope, ...scope] : [];
  const current = db
    .prepare(
      `SELECT source_path, target_path, edge_type FROM vault_edges WHERE vault_id = ? AND edge_type IN (${placeholders})${scopeClause}`,
    )
    .all(vaultId, ...edgeTypes, ...scopeParams) as DerivedRow[];
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

  // UPSERT, not INSERT OR IGNORE. The row key is only (vault, source, target, edge_type), so an edge
  // whose CONFIDENCE or SOURCE_FINGERPRINT changed is the same row — under INSERT OR IGNORE it was
  // silently kept at its stale value and could never be refreshed. Now a re-run updates it in place.
  const up = db.prepare(
    `INSERT INTO vault_edges (vault_id, source_path, target_path, edge_type, edge_kind, provenance, confidence, source_fingerprint, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(vault_id, source_path, target_path, edge_type) DO UPDATE SET
       edge_kind = excluded.edge_kind,
       provenance = excluded.provenance,
       confidence = excluded.confidence,
       source_fingerprint = excluded.source_fingerprint,
       updated_at = excluded.updated_at`,
  );
  let inserted = 0;
  let updated = 0;
  for (const e of desired) {
    const isNew = !currentKeys.has(key(e.source_path, e.target_path, e.edge_type));
    up.run(
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
    if (isNew) inserted += 1;
    else updated += 1;
  }
  return { desired: desired.length, inserted, updated, deleted };
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
  const owned = new Set<string>(edgeTypes);
  // A desired edge outside the owned set would let a stale-delete wipe an edge this call is not
  // authoritative over — fail loudly instead.
  for (const e of desired) {
    if (!owned.has(e.edge_type)) {
      throw new Error(`reconcileDerivedEdges: desired edge_type '${e.edge_type}' not in owned set`);
    }
  }
  return reconcileDerivedEdgesCore(db, vaultId, desired, edgeTypes, null, now);
}

/**
 * THE-486 delta counterpart to reconcileDerivedEdges: reads, deletes, and upserts ONLY rows of
 * `edgeTypes` where at least one endpoint is in `scope` — an edge entirely outside `scope` is assumed
 * already correct (nothing that could invalidate it changed this pass) and is never touched. Correct
 * ONLY when the caller's `scope` covers every note whose derived edges of this type could have
 * changed (computeKnnEdgesForPaths + knnNeighborScope, or tagCooccurrenceEdgesForNotes +
 * tagCooccurrenceScope, build exactly that). Every `desired` edge MUST touch `scope` — an edge that
 * doesn't could never be deleted by a later scoped pass that doesn't happen to cover it either,
 * silently orphaning it — so this throws instead of accepting one. `scope` empty is a clean, query-
 * free no-op: the table is left exactly as it was, which is the correct outcome when nothing that
 * could affect this edge_type changed.
 */
export function reconcileDerivedEdgesScoped(
  db: Database,
  vaultId: string,
  desired: DerivedEdge[],
  edgeTypes: DerivedEdgeType[],
  scope: ReadonlySet<string>,
  now: () => number = Date.now,
): DerivedReconcileStats {
  if (scope.size === 0) return { desired: 0, inserted: 0, updated: 0, deleted: 0 };
  const owned = new Set<string>(edgeTypes);
  for (const e of desired) {
    if (!owned.has(e.edge_type)) {
      throw new Error(
        `reconcileDerivedEdgesScoped: desired edge_type '${e.edge_type}' not in owned set`,
      );
    }
    if (!scope.has(e.source_path) && !scope.has(e.target_path)) {
      throw new Error(
        `reconcileDerivedEdgesScoped: desired edge ${e.source_path}->${e.target_path} touches neither endpoint in scope`,
      );
    }
  }
  return reconcileDerivedEdgesCore(db, vaultId, desired, edgeTypes, scope, now);
}

/** THE-486: how many rows of `edgeType` currently exist for `vaultId` — used to detect a "cold start"
 *  (the layer has never been populated, or was just fully pruned by a flag flip) where a delta pass
 *  has no correct baseline to build on and must fall back to a full recompute instead. */
export function countDerivedEdges(
  db: Database,
  vaultId: string,
  edgeType: DerivedEdgeType,
): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM vault_edges WHERE vault_id = ? AND edge_type = ?")
    .get(vaultId, edgeType) as { n: number };
  return row.n;
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

// THE-486: shared body for computeKnnEdges (full) and computeKnnEdgesForPaths (delta). `scopeSql` is
// an extra SQL fragment (with its bind params) restricting which chunks are queried as a SOURCE — the
// CANDIDATE pool vecKnn searches is always the full vec_chunks index either way, so a restricted scope
// only cuts how many outer per-chunk vecKnn calls run, never correctness of any single call's result.
function knnEdgesFromChunkRows(
  db: Database,
  vaultId: string,
  k: number,
  scopeSql: string,
  scopeParams: unknown[],
  opts: { k?: number; minSim?: number },
): DerivedEdge[] {
  const hasVecChunks =
    db.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'vec_chunks'").get() !== undefined;
  if (!loadVec(db) || !hasVecChunks) return [];
  const rows = db
    .prepare(
      `SELECT c.path AS path, e.embedding AS embedding FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE e.is_active = 1 AND c.vault_id = ?${scopeSql}`,
    )
    .all(vaultId, ...scopeParams) as Array<{ path: string; embedding: Uint8Array }>;
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

/**
 * Compute note-level kNN `similar_to` edges over vec_chunks for `vaultId`. For each active chunk
 * embedding, vec0 kNN finds its nearest chunks (the +path aux column rides along free), which map to
 * neighbor NOTES; knnEdgesFromNeighbors collapses those to per-note edges. Requires the sqlite-vec
 * extension (loadVec) + a populated vec_chunks; returns [] when the extension is unavailable
 * (node:sqlite) so indexing degrades cleanly instead of throwing. Over-fetches per chunk (many chunks
 * share a note, plus the self-hit) so k neighbor NOTES survive the note-collapse.
 *
 * Scans EVERY active chunk in the vault as a source — THE-486's computeKnnEdgesForPaths is the
 * delta-only counterpart used once a baseline exists (see indexVault's cold-start check).
 */
export function computeKnnEdges(
  db: Database,
  vaultId: string,
  opts: { k?: number; minSim?: number } = {},
): DerivedEdge[] {
  const k = opts.k ?? 8;
  return knnEdgesFromChunkRows(db, vaultId, k, "", [], opts);
}

/**
 * THE-486 delta counterpart to computeKnnEdges: only chunks belonging to a note in `scope` are queried
 * as a SOURCE (the same per-chunk vecKnn call otherwise, searching the full index). `scope` must
 * already include a changed note's prior edge-neighbors — knnNeighborScope builds exactly that — or an
 * edge that only exists because some untouched note B ranked the changed note among B's OWN top-k
 * would go stale unnoticed (B itself never re-queried). Returns [] when `scope` is empty: a genuine
 * no-op, no query at all (this is what makes a zero-change reindex perform no kNN scan).
 */
export function computeKnnEdgesForPaths(
  db: Database,
  vaultId: string,
  scope: ReadonlySet<string>,
  opts: { k?: number; minSim?: number } = {},
): DerivedEdge[] {
  if (scope.size === 0) return [];
  const k = opts.k ?? 8;
  const placeholders = [...scope].map(() => "?").join(", ");
  return knnEdgesFromChunkRows(
    db,
    vaultId,
    k,
    ` AND c.path IN (${placeholders})`,
    [...scope],
    opts,
  );
}

/**
 * THE-486: 1-hop neighbor expansion for the kNN delta scope. A chunk whose embedding changed can flip
 * whether it sits inside SOME OTHER, unchanged note's own top-k (the neighbor's ranking of a candidate
 * it was already comparing against changed, even though the neighbor's OWN embedding did not) — so
 * every note on the other end of an EXISTING `similar_to` edge touching a changed note must be
 * re-scored too, not just the changed note itself. Reads the CURRENT edges (both directions, since
 * they're stored in canonical path order), so this must run BEFORE the pass's reconcile deletes
 * anything. `changed` empty short-circuits with no query.
 */
export function knnNeighborScope(
  db: Database,
  vaultId: string,
  changed: ReadonlySet<string>,
): Set<string> {
  const scope = new Set<string>(changed);
  if (changed.size === 0) return scope;
  const placeholders = [...changed].map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT source_path, target_path FROM vault_edges WHERE vault_id = ? AND edge_type = 'similar_to' AND (source_path IN (${placeholders}) OR target_path IN (${placeholders}))`,
    )
    .all(vaultId, ...changed, ...changed) as Array<{ source_path: string; target_path: string }>;
  for (const r of rows) {
    scope.add(r.source_path);
    scope.add(r.target_path);
  }
  return scope;
}
