// THE-465 "graphExpansion" stage: literal wikilink graph walk from the strongest seeds, hub
// suppression, Ebbinghaus decay, THE-401 smooth scoring, and densification down-weighting.
// Moved verbatim out of graphSearchCore's step 3 (skipped entirely when the router routes to
// seeds-only — same gate, same defaults for every graphStream/smoothExpansion/decay/densify
// sub-option).
import type { Database } from "../../db/types";
import { expandGraphLiteral } from "../graph_expand";
import { cosineSimilarity } from "../native";
import { blobToFloats } from "../vec";
import { type Candidate, type ChunkEmbRow, type GraphSearchOptions, MS_PER_DAY } from "./types";

export interface GraphExpansionInput {
  db: Database;
  opts: GraphSearchOptions;
  seedPaths: string[];
  seedChunkIds: Set<string>;
  hopLimit: number;
  similarityThreshold: number;
  maxExpansionChunks: number;
  decayEnabled: boolean;
  decayLambda: number;
  decayNowMs: number;
}

export interface GraphExpansionResult {
  expansionChunks: Candidate[];
  // THE-398: raw ordering score (cos, possibly decay/smooth-weighted) per KEPT expansion chunk —
  // the convex fusion normalizes over exactly the chunks that entered the stream.
  expSimById: Map<string, number>;
}

/** 3. Literal graph expansion (skipped when the router fires). Score each expansion chunk by
 *  cosine to the query and gate at similarityThreshold (KMS semantic_chunks). */
export function expandGraph(input: GraphExpansionInput): GraphExpansionResult {
  const {
    db,
    opts,
    seedPaths,
    seedChunkIds,
    hopLimit,
    similarityThreshold,
    maxExpansionChunks,
    decayEnabled,
    decayLambda,
    decayNowMs,
  } = input;
  const isReadable = opts.isReadable;
  const expansionChunks: Candidate[] = [];
  const expSimById = new Map<string, number>();

  // THE-393 capped stream: expand only from the strongest seeds — a rank-25 seed's neighbors
  // are noise amplified through the graph, and hub suppression below needs a bounded frontier.
  const gsEnabled = opts.graphStream?.enabled ?? false;
  const expandFrom = gsEnabled
    ? seedPaths.slice(0, opts.graphStream?.expansionSeeds ?? 8)
    : seedPaths;
  const nodes = expandGraphLiteral(db, expandFrom, {
    vaultId: opts.vaultId,
    hopLimit,
    includeDerived: opts.densify?.includeInWalk ?? false,
  });
  const nodeByPath = new Map(nodes.map((n) => [n.path, n]));
  const paths = [...nodeByPath.keys()];
  // Hub suppression: a node with pathological degree (vault audits, index/dashboard pages)
  // reaches everything, so surfacing it as an expansion "connection" is structural, not
  // semantic. Degree is measured on vault_edges over the candidate nodes only.
  // THE-401: the smooth score needs degrees for every candidate; it REPLACES the hard cap.
  const smooth = opts.smoothExpansion?.enabled ?? false;
  const smLambda = opts.smoothExpansion?.lambda ?? 0.8;
  const smMu = opts.smoothExpansion?.hubMu ?? 75;
  const smGamma = opts.smoothExpansion?.hubGamma ?? 6;
  const hubCap = !smooth && gsEnabled ? (opts.graphStream?.hubDegreeCap ?? 40) : 0;
  const degreeByPath =
    hubCap > 0 || smooth ? nodeDegrees(db, opts.vaultId, paths) : new Map<string, number>();
  if (paths.length > 0) {
    const placeholders = paths.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT c.id AS id, c.path AS path, c.content AS content, e.embedding AS embedding
         FROM chunks c JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.is_active = 1
         WHERE c.vault_id = ? AND c.path IN (${placeholders})`,
      )
      .all(opts.vaultId, ...paths) as ChunkEmbRow[];
    const mtimeByPath = decayEnabled
      ? loadMtimes(db, opts.vaultId, paths)
      : new Map<string, number>();
    const scored: Array<{ cand: Candidate; sim: number }> = [];
    for (const r of rows) {
      if (seedChunkIds.has(r.id)) continue;
      if (isReadable && !isReadable(r.path)) continue;
      if (hubCap > 0 && (degreeByPath.get(r.path) ?? 0) > hubCap) continue;
      const node = nodeByPath.get(r.path);
      if (!node) continue;
      const rawSim = cosineSimilarity(opts.queryVec, blobToFloats(r.embedding));
      if (rawSim < similarityThreshold) continue;
      // Ebbinghaus recency weight (THE-73 P3): reorder by recency without dropping below the gate.
      let sim = rawSim;
      if (decayEnabled) {
        const mtime = mtimeByPath.get(r.path);
        if (mtime !== undefined && mtime > 0) {
          const days = Math.max(0, (decayNowMs - mtime) / MS_PER_DAY);
          sim = rawSim * Math.exp(-decayLambda * days);
        }
      }
      // THE-401: continuous hop decay + hub penalty fold into the stream-ordering score. The
      // similarity GATE above still uses raw cosine, so smooth scoring reorders, never drops.
      if (smooth) {
        const deg = degreeByPath.get(r.path) ?? 0;
        sim *= smLambda ** (node.hop - 1) / (1 + (deg / smMu) ** smGamma);
      }
      // Densification: a derived (kNN / shared-tag) edge is a softer signal than an authored
      // wikilink, so down-weight expansion reached via one — it ranks/annotates, never outranks a
      // literal edge at equal hop. No-op on the literal-only walk (edge_kind always 'literal').
      if (node.edge_kind !== "literal") sim *= opts.densify?.derivedWeight ?? 0.5;
      scored.push({
        sim,
        cand: {
          chunk_id: r.id,
          path: r.path,
          content: r.content,
          source: "expansion",
          hop: node.hop,
          via_edge: {
            type: node.via_edge_type,
            source_path: node.predecessor_path,
            provenance: node.via_edge_provenance,
          },
          root_seed: node.root_seed,
          streamRank: 0,
        },
      });
    }
    // Expansion stream order: smooth mode ranks purely by the continuous score (hop decay is
    // already inside `sim`); legacy order is hop asc, similarity desc (KMS vault_graph_expand).
    if (smooth) scored.sort((a, b) => b.sim - a.sim || a.cand.hop - b.cand.hop);
    else scored.sort((a, b) => a.cand.hop - b.cand.hop || b.sim - a.sim);
    // THE-393 per-seed cap: at most `perSeedCap` expansion chunks per root seed, so one
    // high-degree seed cannot own the whole stream. Infinity when the capped stream is off —
    // then this loop is exactly the historical slice(0, maxExpansionChunks).
    const perSeedCap = gsEnabled ? (opts.graphStream?.perSeedCap ?? 3) : Number.POSITIVE_INFINITY;
    const perSeed = new Map<string, number>();
    let rank = 0;
    for (const s of scored) {
      if (expansionChunks.length >= maxExpansionChunks) break;
      const rootKey = s.cand.root_seed ?? "";
      const taken = perSeed.get(rootKey) ?? 0;
      if (taken >= perSeedCap) continue;
      perSeed.set(rootKey, taken + 1);
      s.cand.streamRank = rank++;
      expSimById.set(s.cand.chunk_id, s.sim);
      expansionChunks.push(s.cand);
    }
  }
  return { expansionChunks, expSimById };
}

// THE-73 Phase 3: note mtimes for the expansion paths (Ebbinghaus decay input). Absent notes table
// (FTS-less / pre-THE-291 index) yields an empty map, so decay silently no-ops (weight stays 1).
function loadMtimes(db: Database, vaultId: string, paths: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (paths.length === 0) return out;
  try {
    const placeholders = paths.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT path, mtime FROM notes WHERE vault_id = ? AND path IN (${placeholders})`)
      .all(vaultId, ...paths) as Array<{ path: string; mtime: number }>;
    for (const r of rows) out.set(r.path, r.mtime);
  } catch {
    // notes table not present on this connection — no decay data.
  }
  return out;
}

// THE-393: undirected degree per node path over vault_edges (source + target sides), batched.
// The measure only needs to catch pathological hubs, so exactness beyond the candidate set is
// irrelevant. Missing table (pre-integration) yields an empty map — suppression no-ops.
function nodeDegrees(db: Database, vaultId: string, paths: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (paths.length === 0) return out;
  const CHUNK = 500;
  try {
    for (let i = 0; i < paths.length; i += CHUNK) {
      const slice = paths.slice(i, i + CHUNK);
      const placeholders = slice.map(() => "?").join(",");
      for (const col of ["source_path", "target_path"]) {
        const rows = db
          .prepare(
            // Hub degree counts AUTHORED structure only. A hub is a node the operator wired into many
            // notes (an index page, a dashboard) — not a node that happens to sit in many kNN
            // neighbourhoods. Counting derived edges here let densification sabotage itself: doubling the
            // edge count inflated every degree, pushing legitimate bridge notes past the hub threshold
            // and suppressing the exact nodes densification exists to surface (measured: bridge recall
            // 0.831 -> 0.824 with derived edges counted). Excluding the derived types leaves the literal
            // graph's degrees byte-identical, so the shipped champion is unaffected.
            `SELECT ${col} AS p, COUNT(*) AS n FROM vault_edges
             WHERE vault_id = ?
               AND edge_type NOT IN ('shared_tag', 'similar_to', 'semantically_similar_to')
               AND ${col} IN (${placeholders})
             GROUP BY ${col}`,
          )
          .all(vaultId, ...slice) as Array<{ p: string; n: number }>;
        for (const r of rows) out.set(r.p, (out.get(r.p) ?? 0) + r.n);
      }
    }
  } catch {
    return new Map();
  }
  return out;
}
