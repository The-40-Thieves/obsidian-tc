// Dense-vector retrieval over the chunk store. Two interchangeable backends that
// agree by construction (both rank by cosine):
//   - vec0: when the connection has sqlite-vec loaded and vec_chunks exists, KNN
//     runs in SQLite (cosine distance = 1 - similarity). Used under bun:sqlite.
//   - brute force: decode every active embedding and score in-process. Always
//     correct and ACL-aware; the only path available under node:sqlite (vitest).
// The query path is ACL-filtered: chunks whose note is not read-visible are
// dropped before scoring, so semantic search never leaks across the read ACL.
import type { Database } from "../db/types";
import { cosineSimilarity } from "./native";
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

interface MetaRow {
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
      const candidates = vecKnn(db, queryVec, k * 5 + 10);
      const out: SemanticHit[] = [];
      if (candidates.length > 0) {
        const placeholders = candidates.map(() => "?").join(", ");
        const metaRows = db
          .prepare(
            `SELECT c.id AS id, c.path AS path, c.content AS content, c.vault_id AS vault_id, e.model AS model FROM chunks c JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.is_active = 1 WHERE c.id IN (${placeholders})`,
          )
          .all(...candidates.map((r) => r.chunk_id)) as Array<MetaRow & { id: string }>;
        const metaById = new Map(metaRows.map((m) => [m.id, m]));
        for (const row of candidates) {
          const m = metaById.get(row.chunk_id);
          if (!m || m.vault_id !== vaultId || !readable(m.path)) continue;
          const score = 1 - row.distance;
          if (opts.minScore !== undefined && score < opts.minScore) continue;
          out.push(hit(row.chunk_id, m.path, score, m.model, m.content, opts.returnContent));
          if (out.length >= k) break;
        }
      }
      vecHits = out;
    } catch {
      // The brute-force scan is dimension-tolerant (cosineSimilarity returns 0 on a length
      // mismatch) and always correct, so it is the safe fallback for any vec0 failure.
      vecHits = null;
    }
  }
  if (vecHits !== null) return vecHits;

  const rows = db
    .prepare(
      "SELECT c.id AS id, c.path AS path, c.content AS content, e.model AS model, e.embedding AS embedding FROM chunks c JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.is_active = 1 WHERE c.vault_id = ?",
    )
    .all(vaultId) as BruteRow[];
  const scored: SemanticHit[] = [];
  for (const r of rows) {
    if (!readable(r.path)) continue;
    const score = cosineSimilarity(queryVec, blobToFloats(r.embedding));
    if (opts.minScore !== undefined && score < opts.minScore) continue;
    scored.push(hit(r.id, r.path, score, r.model, r.content, opts.returnContent));
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
