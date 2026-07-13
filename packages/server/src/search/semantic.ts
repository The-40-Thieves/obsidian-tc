// Dense-vector retrieval over the chunk store. Two interchangeable backends that
// agree by construction (both rank by cosine):
//   - vec0: when the connection has sqlite-vec loaded and vec_chunks exists, KNN
//     runs in SQLite (cosine distance = 1 - similarity). Used under bun:sqlite.
//   - brute force: decode every active embedding and score in-process. Always
//     correct and ACL-aware; the only path available under node:sqlite (vitest).
// The query path is ACL-filtered: chunks whose note is not read-visible are
// dropped before scoring, so semantic search never leaks across the read ACL.
import type { Database } from "../db/types";
import { cosineBatch } from "./native";
import { blobToFloats, loadVec, vecKnn } from "./vec";

export interface SemanticHit {
  chunk_id: string;
  path: string;
  score: number;
  content?: string;
  embedding_model: string;
}

export interface SemanticOptions {
  k: number;
  minScore?: number;
  returnContent?: boolean;
  isReadable?: (path: string) => boolean;
}

function tableExists(db: Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?")
    .get(name);
  return row !== undefined;
}

export interface MetaRow {
  path: string;
  content: string;
  vault_id: string;
  model: string;
}

interface BruteRow {
  id: string;
  path: string;
  content: string;
  model: string;
  embedding: Uint8Array;
}

export function semanticSearch(
  db: Database,
  vaultId: string,
  queryVec: number[],
  opts: SemanticOptions,
): SemanticHit[] {
  const { k } = opts;
  const readable = opts.isReadable ?? (() => true);
  if (k <= 0) return [];

  // vec0 KNN path: over-fetch candidates, then resolve their metadata in ONE batched query
  // (collapsing a per-candidate point lookup), preserving vecKnn's distance ordering. Any vec0
  // failure — e.g. the query vector's dimension no longer matches the indexed vectors after an
  // embedding-model change, which makes sqlite-vec throw — degrades to the brute-force scan
  // below instead of propagating the error.
  let vecHits: SemanticHit[] | null = null;
  if (loadVec(db) && tableExists(db, "vec_chunks")) {
    try {
      // Over-fetch generously; the metadata join scopes to this vault IN SQL (the KNN is global
      // over vec_chunks, so a shared cache.db can surface other vaults' candidates) and JS applies
      // the read ACL. If the top-`overFetch` candidates can't fill k visible hits AND the index
      // holds at least `overFetch` chunks (visible ones may sit below the cutoff), fall back to the
      // exhaustive brute-force scan — this closes the crowding-out zero-hits case and the
      // cross-vault / ACL existence side-channel where a global KNN's top-N is dominated by chunks
      // the caller cannot see (THE-287).
      const overFetch = k * 20 + 50;
      // THE-277: the vault_id partition key prunes the KNN to this vault's shard — other
      // vaults' vectors are never scanned, so cross-vault crowding (THE-287) is structurally
      // gone; the over-fetch + fallback below still guards ACL-invisible chunks WITHIN the vault.
      const candidates = vecKnn(db, queryVec, overFetch, vaultId);
      let out: SemanticHit[] = [];
      if (candidates.length > 0) {
        const placeholders = candidates.map(() => "?").join(", ");
        const metaRows = db
          .prepare(
            `SELECT c.id AS id, c.path AS path, c.content AS content, c.vault_id AS vault_id, e.model AS model FROM chunks c JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.is_active = 1 WHERE c.vault_id = ? AND c.id IN (${placeholders})`,
          )
          .all(vaultId, ...candidates.map((r) => r.chunk_id)) as Array<MetaRow & { id: string }>;
        const metaById = new Map(metaRows.map((m) => [m.id, m]));
        out = selectVisible(candidates, metaById, readable, opts, k);
      }
      // Trust vec0 only when it filled k, or the index returned fewer candidates than the cap (we
      // have then seen every chunk). Otherwise crowding is possible -> exhaustive fallback.
      vecHits = out.length >= k || candidates.length < overFetch ? out : null;
    } catch {
      // Any vec0 failure (e.g. a dimension mismatch after an embedding-model change) degrades to
      // the dimension-tolerant brute-force scan below.
      vecHits = null;
    }
  }
  if (vecHits !== null) return vecHits;

  const rows = db
    .prepare(
      "SELECT c.id AS id, c.path AS path, c.content AS content, e.model AS model, e.embedding AS embedding FROM chunks c JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.is_active = 1 WHERE c.vault_id = ?",
    )
    .all(vaultId) as BruteRow[];
  // THE-420: score the whole candidate set in ONE native crossing instead of one per row.
  // Per-pair cosine across the boundary is dominated by re-marshaling the f64 query on every
  // call (measured 13-22x slower than JS); cosineBatch marshals the query once and scans the
  // corpus in native. ACL-filter FIRST so invisible chunks are never scored; chunk_embeddings
  // can hold mixed dims (e.model varies), which the per-pair path scored 0 — preserved here.
  const visible = rows.filter((r) => readable(r.path));
  const dim = queryVec.length;
  const same = visible.filter((r) => r.embedding.byteLength === dim * 4);
  const mismatched = visible.filter((r) => r.embedding.byteLength !== dim * 4);
  const flat = new Float32Array(same.length * dim);
  same.forEach((r, i) => {
    flat.set(blobToFloats(r.embedding), i * dim);
  });
  const scores = same.length > 0 ? cosineBatch(queryVec, flat, dim) : new Float64Array(0);
  const scored: SemanticHit[] = [];
  same.forEach((r, i) => {
    const score = scores[i] ?? 0;
    if (opts.minScore !== undefined && score < opts.minScore) return;
    scored.push(hit(r.id, r.path, score, r.model, r.content, opts.returnContent));
  });
  for (const r of mismatched) {
    if (opts.minScore !== undefined && opts.minScore > 0) continue;
    scored.push(hit(r.id, r.path, 0, r.model, r.content, opts.returnContent));
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

function hit(
  chunkId: string,
  path: string,
  score: number,
  model: string,
  content: string,
  returnContent?: boolean,
): SemanticHit {
  return {
    chunk_id: chunkId,
    path,
    score,
    embedding_model: model,
    ...(returnContent ? { content } : {}),
  };
}

/**
 * Filter distance-ordered vec0 candidates to the caller's readable, above-minScore top-k,
 * preserving distance order. `metaById` is already vault-scoped by the SQL join, so a candidate
 * absent from it belongs to another vault and is skipped. Extracted for THE-287 so the visibility
 * filter is unit-tested independently of a live vec0 backend.
 */
export function selectVisible(
  candidates: Array<{ chunk_id: string; distance: number }>,
  metaById: Map<string, MetaRow & { id: string }>,
  readable: (path: string) => boolean,
  opts: Pick<SemanticOptions, "minScore" | "returnContent">,
  k: number,
): SemanticHit[] {
  const out: SemanticHit[] = [];
  for (const row of candidates) {
    const m = metaById.get(row.chunk_id);
    if (!m || !readable(m.path)) continue;
    const score = 1 - row.distance;
    if (opts.minScore !== undefined && score < opts.minScore) continue;
    out.push(hit(row.chunk_id, m.path, score, m.model, m.content, opts.returnContent));
    if (out.length >= k) break;
  }
  return out;
}
