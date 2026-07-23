// THE-465 "diversity" stage: note-collapse, KMeans cluster cap, and MMR final pick. Moved
// verbatim out of graphSearchCore's post-fusion diversification pipeline (graph_rrf/convex modes
// only) — same order (note-collapse first, then cluster cap, then MMR), same finalTopK/pool-size
// bounds.
import type { Database } from "../../db/types";
import { cosineSimilarity } from "../native";
import { blobToFloats } from "../vec";
import type { Candidate, GraphSearchOptions } from "./types";

export interface DiversityInput {
  db: Database;
  opts: GraphSearchOptions;
  fused: Candidate[];
  finalTopK: number;
  scoreOfWithPrior: (c: Candidate) => number;
}

/** THE-393 diversification pipeline: note-collapse first (exact path-grain guarantee), then the
 *  legacy cluster cap if configured, then MMR picks the final K from what survives. */
export function applyDiversity(input: DiversityInput): Candidate[] {
  const { db, opts, fused, finalTopK, scoreOfWithPrior } = input;
  let pool = fused;
  const maxPerNote = opts.diversify?.maxPerNote ?? 0;
  if (maxPerNote > 0) pool = collapseByNote(pool, maxPerNote);
  if (opts.maxPerCluster && opts.maxPerCluster > 0) {
    // Don't pre-truncate to finalTopK when an MMR pass follows: mmrSelect early-returns the pool
    // UNCHANGED when it receives ≤ k candidates, so a cluster cap that trims to finalTopK would
    // silently disable MMR. Leave it a pool larger than k (matching mmrSelect's max(k*3,45) bound).
    const capLimit =
      (opts.diversify?.mmr?.enabled ?? false) ? Math.max(finalTopK * 3, 45) : finalTopK;
    pool = diversifyByCluster(db, opts.vaultId, pool, opts.maxPerCluster, capLimit);
  }
  return (opts.diversify?.mmr?.enabled ?? false)
    ? mmrSelect(db, pool, finalTopK, opts.diversify?.mmr?.lambda ?? 0.7, scoreOfWithPrior)
    : pool.slice(0, finalTopK);
}

// THE-393: walk the fused ranking keeping at most maxPerNote chunks per note path — an exact
// path-grain diversity guarantee (results are consumed per-path downstream), cheaper and more
// direct than embedding-space partitioning.
function collapseByNote(fused: Candidate[], maxPerNote: number): Candidate[] {
  const counts = new Map<string, number>();
  const out: Candidate[] = [];
  for (const c of fused) {
    const n = counts.get(c.path) ?? 0;
    if (n >= maxPerNote) continue;
    counts.set(c.path, n + 1);
    out.push(c);
  }
  return out;
}

// THE-73 Phase 2: walk the RRF-sorted candidates and keep at most maxPerCluster from each cluster_id
// before filling finalTopK, so one dense semantic neighbourhood cannot crowd out the rest. cluster_id
// is looked up in batches; a NULL/absent cluster_id is treated as unique (never capped), so the pass
// is a no-op until `obsidian-tc cluster` has populated the column.
function diversifyByCluster(
  db: Database,
  vaultId: string,
  fused: Candidate[],
  maxPerCluster: number,
  finalTopK: number,
): Candidate[] {
  const clusterOf = new Map<string, number>();
  const ids = fused.map((c) => c.chunk_id);
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT id, cluster_id FROM chunks WHERE vault_id = ? AND id IN (${placeholders})`)
      .all(vaultId, ...slice) as Array<{ id: string; cluster_id: number | null }>;
    for (const r of rows) if (r.cluster_id != null) clusterOf.set(r.id, r.cluster_id);
  }
  const counts = new Map<number, number>();
  const out: Candidate[] = [];
  for (const c of fused) {
    const cl = clusterOf.get(c.chunk_id);
    if (cl !== undefined) {
      const n = counts.get(cl) ?? 0;
      if (n >= maxPerCluster) continue;
      counts.set(cl, n + 1);
    }
    out.push(c);
    if (out.length >= finalTopK) break;
  }
  return out;
}

// THE-393: Maximal Marginal Relevance over the fused pool — greedy pick maximizing
// lambda * relevance - (1 - lambda) * redundancy, where relevance is the min-max-normalized RRF
// score and redundancy is the max cosine to an already-picked chunk. The rank-1 candidate is
// always picked first (its relevance is 1 and nothing is selected yet), so MMR can only reorder
// the tail, never displace the top hit. Pool is bounded at 3*K; chunks without a stored
// embedding contribute zero redundancy (never over-penalized).
function mmrSelect(
  db: Database,
  pool0: Candidate[],
  k: number,
  lambda: number,
  score: (c: Candidate) => number,
): Candidate[] {
  const pool = pool0.slice(0, Math.max(k * 3, 45));
  if (pool.length <= k) return pool;
  const embById = loadEmbeddings(
    db,
    pool.map((c) => c.chunk_id),
  );
  // The native cosineSimilarity binding wants (plain array, typed array) — the same shape as the
  // expansion-scoring call above — so hold both representations, aligned to the pool.
  const embF32 = pool.map((c) => embById.get(c.chunk_id));
  const embPlain = embF32.map((f) => (f ? Array.from(f) : undefined));
  const scores = pool.map(score);
  const max = Math.max(...scores);
  const min = Math.min(...scores);
  const rel = scores.map((s) => (max > min ? (s - min) / (max - min) : 1));
  const chosen: number[] = [];
  const chosenSet = new Set<number>();
  while (chosen.length < k) {
    let bestI = -1;
    let bestV = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < pool.length; i++) {
      if (chosenSet.has(i)) continue;
      let redundancy = 0;
      const ei = embPlain[i];
      if (ei) {
        for (const j of chosen) {
          const ej = embF32[j];
          if (ej) redundancy = Math.max(redundancy, cosineSimilarity(ei, ej));
        }
      }
      const v = lambda * (rel[i] ?? 0) - (1 - lambda) * redundancy;
      if (v > bestV) {
        bestV = v;
        bestI = i;
      }
    }
    if (bestI < 0) break;
    chosen.push(bestI);
    chosenSet.add(bestI);
  }
  const picked: Candidate[] = [];
  for (const i of chosen) {
    const c = pool[i];
    if (c) picked.push(c);
  }
  return picked;
}

// Active embeddings for a candidate set (chunk ids are globally unique — chk_ of a
// vault+path+index hash — so no vault filter is needed), batched IN lookups.
function loadEmbeddings(db: Database, ids: string[]): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT chunk_id, embedding FROM chunk_embeddings WHERE is_active = 1 AND chunk_id IN (${placeholders})`,
      )
      .all(...slice) as Array<{ chunk_id: string; embedding: Uint8Array }>;
    for (const r of rows) out.set(r.chunk_id, blobToFloats(r.embedding));
  }
  return out;
}
