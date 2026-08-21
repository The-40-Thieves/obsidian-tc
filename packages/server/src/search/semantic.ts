// Dense-vector retrieval over the chunk store. Two interchangeable backends that
// agree by construction (both rank by cosine):
//   - vec0: when the connection has sqlite-vec loaded and vec_chunks exists, KNN
//     runs in SQLite (cosine distance = 1 - similarity). Used under bun:sqlite.
//   - brute force: decode every active embedding and score in-process. Always
//     correct and ACL-aware; the only path available under node:sqlite (vitest).
// The query path is ACL-filtered: chunks whose note is not read-visible are
// dropped before scoring, so semantic search never leaks across the read ACL.

import { tableExists } from "../db/introspect";
import type { Database } from "../db/types";
import { cosineBatch } from "./native";
import { blobToFloats, loadVec, vecKnn } from "./vec";

export interface SemanticHit {
  chunk_id: string;
  path: string;
  score: number;
  content?: string;
  embedding_model: string;
  /** THE-450: note-content age in whole days, stamped additively from the note mtime. */
  age_days?: number;
  /** THE-450: true when the note is older than the stale threshold (informational, never ranks). */
  stale?: boolean;
}

export interface SemanticOptions {
  k: number;
  minScore?: number;
  returnContent?: boolean;
  isReadable?: (path: string) => boolean;
  /** THE-530: the active embedding model. When set, the brute-force scan filters chunk_embeddings to
   *  this model IN SQL, so a same-dimension vector from a SUPERSEDED model is never scored against a
   *  new-model query (is_active=1 + byteLength===dim*4 are both satisfied by the old vector). This
   *  makes the fallback agree with the vec0 path (THE-460). Omitted -> no filter (back-compat). */
  model?: string;
  /** THE-585: fired with why the vec0 KNN path was abandoned for the brute-force scan — both
   *  reasons are otherwise-silent degradations (correct results, different cost profile).
   *  - "error"     — vec0 threw, usually a dimension mismatch after an embedding-model change.
   *  - "underfill" — vec0's over-fetched candidates couldn't fill k visible hits while the index
   *                  held at least `overFetch` chunks: ACL-invisible chunks may be crowding out
   *                  visible ones (THE-287).
   *  A callback, not a metrics handle, so this module stays ignorant of the metrics recorder —
   *  see docs/design/retrieval-dense-index.md. Best-effort: a throwing callback must never break
   *  a search. */
  onFallback?: (reason: "error" | "underfill") => void;
}

/** Fire `onFallback` without letting it affect the search. The callback is observability; a
 *  throwing metrics sink must never turn a correct (if slower) result into an error — the same
 *  best-effort contract retrievalLog and the audit writer carry. */
function notifyFallback(opts: SemanticOptions, reason: "error" | "underfill"): void {
  try {
    opts.onFallback?.(reason);
  } catch {
    /* observability is never load-bearing */
  }
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
  if (loadVec(db) && tableExists(db, "vec_chunks", { includeViews: true })) {
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
      // THE-585: reported only on the crowding branch, not the "index is smaller than the
      // over-fetch" branch — the latter is an exhaustive read, not a degradation.
      if (vecHits === null) notifyFallback(opts, "underfill");
    } catch {
      // Any vec0 failure (e.g. a dimension mismatch after an embedding-model change) degrades to
      // the dimension-tolerant brute-force scan below.
      vecHits = null;
      notifyFallback(opts, "error"); // THE-585
    }
  }
  if (vecHits !== null) return vecHits;

  // THE-530: filter to the active model IN SQL so a superseded-model vector at the same dimension is
  // never fetched or scored (excluded outright, matching the vec0 path — not surfaced at score 0). The
  // join already touches chunk_embeddings, so the predicate is free and avoids decoding dead blobs.
  const rows = (
    opts.model !== undefined
      ? db
          .prepare(
            "SELECT c.id AS id, c.path AS path, c.content AS content, e.model AS model, e.embedding AS embedding FROM chunks c JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.is_active = 1 WHERE c.vault_id = ? AND e.model = ?",
          )
          .all(vaultId, opts.model)
      : db
          .prepare(
            "SELECT c.id AS id, c.path AS path, c.content AS content, e.model AS model, e.embedding AS embedding FROM chunks c JOIN chunk_embeddings e ON e.chunk_id = c.id AND e.is_active = 1 WHERE c.vault_id = ?",
          )
          .all(vaultId)
  ) as BruteRow[];
  // THE-420: score the whole candidate set in one native crossing instead of one per row —
  // per-pair cosine across the boundary is dominated by re-marshaling the f64 query on every
  // call (see docs/design/retrieval-dense-index.md for the measurement); cosineBatch marshals
  // the query once and scans the corpus in native. ACL-filter FIRST so invisible chunks are
  // never scored; chunk_embeddings can hold mixed dims (e.model varies), scored 0 — preserved.
  const visible = rows.filter((r) => readable(r.path));
  const dim = queryVec.length;
  const same = visible.filter((r) => r.embedding.byteLength === dim * 4);
  const mismatched = visible.filter((r) => r.embedding.byteLength !== dim * 4);
  const flat = new Float32Array(same.length * dim);
  same.forEach((r, i) => {
    flat.set(blobToFloats(r.embedding), i * dim);
  });
  // THE-504: cosineBatch takes the query as a Float32Array (was number[]) so the native side
  // doesn't rebuild a Vec<f64> from a JS array on every call; convert once here per search.
  const queryF32 = Float32Array.from(queryVec);
  const scores = same.length > 0 ? cosineBatch(queryF32, flat, dim) : new Float64Array(0);
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
  // THE-582: total order — score descending, then chunk_id. The rows feeding this sort come from a
  // SELECT with no ORDER BY at all, so tied scores would otherwise resolve in table-scan order, and
  // this fallback would rank identical-content chunks differently from the vec0 path above (which
  // now breaks the same ties on the same key). Code-unit comparison, not localeCompare.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.chunk_id < b.chunk_id ? -1 : a.chunk_id > b.chunk_id ? 1 : 0;
  });
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
