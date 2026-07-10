// bge-m3 learned-sparse retrieval — THE-388. A sparse vector is a token-id -> weight map (bge-m3's
// `lexical_weights`). Stored per chunk in chunk_sparse (runtime-provisioned, JSON weights) and
// scored by sparse dot product: the LEARNED-lexical analogue of the FTS5 BM25 stream (THE-73),
// fused into graph_search as another RRF stream. The ENCODER that produces the weights (bge-m3 via
// ONNX / vLLM) is separate and infra-gated; this module is the storage + retrieval side, exercised
// in tests with hand-built weights.
import type { Database } from "../db/types";

/** token id (string key) -> weight. Empty means "no sparse signal". */
export type SparseVec = Record<string, number>;

/** Sparse dot product over shared token ids (iterating the smaller map). */
export function sparseDot(a: SparseVec, b: SparseVec): number {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  const [small, large] = aKeys.length <= bKeys.length ? [a, b] : [b, a];
  let s = 0;
  for (const k of Object.keys(small)) {
    const sv = small[k];
    const lv = large[k];
    if (sv !== undefined && lv !== undefined) s += sv * lv;
  }
  return s;
}

const sparseCache = new WeakMap<Database, boolean>();

function chunksTableExists(db: Database): boolean {
  return (
    db
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'chunks'")
      .get() !== undefined
  );
}

/**
 * Provision chunk_sparse (a plain table, runtime-provisioned like chunk_fts so an older cache.db
 * gains it on next open). Returns false only when the chunks table is absent. cluster/vec-style
 * lazy provisioning keeps a cache.db written without the sparse feature openable.
 */
export function ensureChunkSparse(db: Database): boolean {
  const cached = sparseCache.get(db);
  if (cached !== undefined) return cached;
  if (!chunksTableExists(db)) {
    sparseCache.set(db, false);
    return false;
  }
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS chunk_sparse (chunk_id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, weights TEXT NOT NULL)",
    );
    db.exec("CREATE INDEX IF NOT EXISTS idx_chunk_sparse_vault ON chunk_sparse(vault_id)");
    sparseCache.set(db, true);
    return true;
  } catch {
    sparseCache.set(db, false);
    return false;
  }
}

/** Upsert a chunk's sparse weights. Caller owns the transaction + the hasChunkSparse guard. */
export function upsertChunkSparse(
  db: Database,
  chunkId: string,
  vaultId: string,
  weights: SparseVec,
): void {
  db.prepare(
    "INSERT INTO chunk_sparse (chunk_id, vault_id, weights) VALUES (?, ?, ?) ON CONFLICT(chunk_id) DO UPDATE SET vault_id = excluded.vault_id, weights = excluded.weights",
  ).run(chunkId, vaultId, JSON.stringify(weights));
}

/** Delete a chunk's sparse row. */
export function deleteChunkSparse(db: Database, chunkId: string): void {
  db.prepare("DELETE FROM chunk_sparse WHERE chunk_id = ?").run(chunkId);
}

export interface SparseHit {
  chunk_id: string;
  path: string;
  content: string;
  score: number;
}

/**
 * Rank chunks by sparse dot product with the query weights (brute-force scan — fine for a personal
 * vault, the same posture as semanticSearch's brute-force fallback; an inverted index is the
 * scale-up follow-up). Returns the top-k positive-scoring hits. [] when chunk_sparse is absent or
 * the query is empty, so the caller's sparse stream contributes nothing.
 */
export function sparseSearch(
  db: Database,
  vaultId: string,
  query: SparseVec,
  k: number,
): SparseHit[] {
  if (k <= 0 || Object.keys(query).length === 0) return [];
  let rows: Array<{ chunk_id: string; path: string; content: string; weights: string }>;
  try {
    rows = db
      .prepare(
        "SELECT s.chunk_id AS chunk_id, c.path AS path, c.content AS content, s.weights AS weights FROM chunk_sparse s JOIN chunks c ON c.id = s.chunk_id WHERE s.vault_id = ?",
      )
      .all(vaultId) as Array<{ chunk_id: string; path: string; content: string; weights: string }>;
  } catch {
    return [];
  }
  const scored: SparseHit[] = [];
  for (const r of rows) {
    let w: SparseVec;
    try {
      w = JSON.parse(r.weights) as SparseVec;
    } catch {
      continue;
    }
    const score = sparseDot(query, w);
    if (score > 0) scored.push({ chunk_id: r.chunk_id, path: r.path, content: r.content, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
