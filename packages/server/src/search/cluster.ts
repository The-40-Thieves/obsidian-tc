// KMeans cluster diversification — THE-73 Phase 2. Spherical k-means (unit-normalised vectors, so
// euclidean distance is monotone in cosine) over a vault's active chunk embeddings, persisted to
// chunks.cluster_id (a V2-reserved column). graph_search then caps how many chunks per cluster reach
// the final result, so a query cannot return N near-duplicate chunks from one semantic
// neighbourhood. Clustering is OFFLINE (run via `obsidian-tc cluster`): cluster_id stays NULL until
// then and the cap no-ops, so this is purely additive.
import type { Database } from "../db/types";
import { blobToFloats } from "./vec";

// Deterministic RNG (mulberry32) so a given (corpus, k, seed) reproduces the same assignment —
// needed for stable tests and reproducible re-clusters. Math.random is deliberately NOT used.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalize(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n === 0) return v.slice();
  return v.map((x) => x / n);
}

function sqDist(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    s += d * d;
  }
  return s;
}

export interface KmeansResult {
  /** point index -> cluster id in [0, k). */
  assignments: number[];
  k: number;
  iters: number;
}

/**
 * Spherical k-means over `vectors` (normalised internally). k is clamped to [1, n]. Deterministic
 * given `seed`: k-means++ seeding, Lloyd iterations until assignments are stable or maxIters. Empty
 * clusters are re-seeded to the point farthest from its centroid, so no returned cluster is empty
 * (matters for the diversification cap).
 */
export function kmeans(
  vectors: number[][],
  k: number,
  opts: { maxIters?: number; seed?: number } = {},
): KmeansResult {
  const n = vectors.length;
  if (n === 0) return { assignments: [], k: 0, iters: 0 };
  const kk = Math.max(1, Math.min(k, n));
  const maxIters = opts.maxIters ?? 25;
  const rng = mulberry32(opts.seed ?? 1);
  const pts = vectors.map(normalize);
  const dim = pts[0]?.length ?? 0;
  const at = (i: number): number[] => pts[i] ?? [];

  // k-means++ seeding.
  const centroids: number[][] = [at(Math.floor(rng() * n)).slice()];
  while (centroids.length < kk) {
    const d2 = pts.map((p) => {
      let m = Infinity;
      for (const c of centroids) m = Math.min(m, sqDist(p, c));
      return m;
    });
    const sum = d2.reduce((acc, x) => acc + x, 0);
    let r = rng() * (sum || 1);
    let idx = 0;
    for (; idx < n - 1; idx++) {
      r -= d2[idx] ?? 0;
      if (r <= 0) break;
    }
    centroids.push(at(idx).slice());
  }

  const assign = new Array<number>(n).fill(0);
  let iters = 0;
  for (; iters < maxIters; iters++) {
    let changed = false;
    for (const [i, p] of pts.entries()) {
      let best = 0;
      let bestD = Infinity;
      for (const [c, cen] of centroids.entries()) {
        const d = sqDist(p, cen);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        changed = true;
      }
    }
    // Recompute centroids (mean, re-normalised = spherical), reseeding empty clusters.
    const sums = Array.from({ length: kk }, () => new Array<number>(dim).fill(0));
    const counts = new Array<number>(kk).fill(0);
    for (const [i, p] of pts.entries()) {
      const c = assign[i] ?? 0;
      counts[c] = (counts[c] ?? 0) + 1;
      const s = sums[c] ?? [];
      for (const [d, val] of p.entries()) s[d] = (s[d] ?? 0) + val;
    }
    for (const [c, count] of counts.entries()) {
      if (count === 0) {
        let far = 0;
        let farD = -1;
        for (const [i, p] of pts.entries()) {
          const d = sqDist(p, centroids[assign[i] ?? 0] ?? []);
          if (d > farD) {
            farD = d;
            far = i;
          }
        }
        centroids[c] = at(far).slice();
        assign[far] = c;
        changed = true;
      } else {
        centroids[c] = normalize((sums[c] ?? []).map((x) => x / count));
      }
    }
    if (!changed) break;
  }
  return { assignments: assign, k: kk, iters };
}

export interface ClusterStats {
  vault_id: string;
  chunks: number;
  k: number;
  iters: number;
}

/** Default cluster count for n chunks: ~sqrt(n), clamped to [1, 256]. */
export function defaultK(n: number): number {
  return Math.max(1, Math.min(256, Math.round(Math.sqrt(n))));
}

/**
 * Cluster a vault's active chunk embeddings and persist chunks.cluster_id. Offline maintenance
 * (obsidian-tc cluster). Rows are ordered by id so a given (corpus, k, seed) is reproducible.
 * Returns null when the vault has no embedded chunks.
 */
export function assignClusters(
  db: Database,
  vaultId: string,
  opts: { k?: number; maxIters?: number; seed?: number } = {},
): ClusterStats | null {
  const rows = db
    .prepare(
      "SELECT c.id AS id, e.embedding AS embedding FROM chunks c JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.is_active = 1 WHERE c.vault_id = ? ORDER BY c.id",
    )
    .all(vaultId) as Array<{ id: string; embedding: Uint8Array }>;
  if (rows.length === 0) return null;
  const vectors = rows.map((r) => Array.from(blobToFloats(r.embedding)));
  const k = opts.k ?? defaultK(rows.length);
  const res = kmeans(vectors, k, { maxIters: opts.maxIters, seed: opts.seed });
  const upd = db.prepare("UPDATE chunks SET cluster_id = ? WHERE id = ?");
  db.exec("BEGIN");
  try {
    for (const [i, row] of rows.entries()) upd.run(res.assignments[i] ?? 0, row.id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { vault_id: vaultId, chunks: rows.length, k: res.k, iters: res.iters };
}
