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
  // THE-711: `Object.keys` used to be called THREE times here — twice to compare sizes and once
  // more to iterate — so two of three allocations were pure waste on a per-row hot path.
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  const [smallKeys, small, large] = aKeys.length <= bKeys.length ? [aKeys, a, b] : [bKeys, b, a];
  let s = 0;
  for (const k of smallKeys) {
    const sv = small[k];
    const lv = large[k];
    if (sv !== undefined && lv !== undefined) s += sv * lv;
  }
  return s;
}

/**
 * THE-711 — the packed on-disk form of a sparse vector.
 *
 * Layout, little-endian: `[u32 count][u32 id × count][f32 weight × count]`, ids STRICTLY ASCENDING.
 *
 * The point is not the bytes, it is that scoring no longer parses. The previous format was JSON
 * text re-parsed per row per query: `sparseSearch` scans every chunk in the vault (deliberately —
 * an exhaustive scan is what makes the ACL filter exact), so `JSON.parse` ran once per chunk and
 * allocated a fresh string-keyed object each time, on every request.
 *
 * A first attempt at this stored JSONB instead. That was WRONG and measurably so: the read path is
 * `SELECT weights` → `JSON.parse`, never `json_extract`, so JSONB only added a binary→text render
 * before the same parse. Measured 207.1 ms → 233.3 ms over 2000×400-term rows — 12.6% SLOWER for
 * 3.8% less storage. Changing which text format feeds a parser does not remove the parser.
 *
 * Sorted ids are what make the merge-intersection in `packedDot` possible: two sorted runs
 * intersect in O(n+m) with no hashing and no allocation, against O(n) hash lookups into a freshly
 * built object.
 */
const HEADER_BYTES = 4;

export function packSparse(vec: SparseVec): Uint8Array {
  // Numeric ids only, and that is the producer's actual contract: `pairSparse` (the sole real
  // source) builds keys with `String(tokenId)`. A non-numeric key cannot be a bge-m3 token id, so
  // it is a programming error rather than data to tolerate — throwing keeps it from becoming a
  // silently-dropped term that quietly lowers a score.
  const ids = Object.keys(vec)
    .map((k) => {
      const n = Number(k);
      if (!Number.isInteger(n) || n < 0 || n > 0xffffffff)
        throw new Error(`packSparse: token id must be a u32, got ${JSON.stringify(k)}`);
      return n;
    })
    .sort((x, y) => x - y);
  const buf = new Uint8Array(HEADER_BYTES + ids.length * 8);
  const view = new DataView(buf.buffer);
  view.setUint32(0, ids.length, true);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i] as number;
    view.setUint32(HEADER_BYTES + i * 4, id, true);
    view.setFloat32(HEADER_BYTES + ids.length * 4 + i * 4, vec[String(id)] as number, true);
  }
  return buf;
}

/** Decode a packed blob back to a SparseVec. Only used by tests and diagnostics — the scoring path
 *  deliberately never materialises an object, which is the entire saving. */
export function unpackSparse(blob: Uint8Array): SparseVec {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const n = view.getUint32(0, true);
  const out: SparseVec = {};
  for (let i = 0; i < n; i++) {
    const id = view.getUint32(HEADER_BYTES + i * 4, true);
    out[String(id)] = view.getFloat32(HEADER_BYTES + n * 4 + i * 4, true);
  }
  return out;
}

/**
 * Dot product of a packed query against a packed row, by merge-intersection over two ascending id
 * runs. No parse, no allocation, no hashing — the whole reason the format changed.
 *
 * Returns 0 for a malformed or truncated blob rather than throwing: a single bad row must not take
 * down a whole-vault scan, matching the JSON.parse-catch it replaces.
 */
export function packedDot(
  queryIds: Uint32Array,
  queryWeights: Float32Array,
  blob: Uint8Array,
): number {
  if (blob.byteLength < HEADER_BYTES) return 0;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const n = view.getUint32(0, true);
  if (blob.byteLength < HEADER_BYTES + n * 8) return 0;
  const wOffset = HEADER_BYTES + n * 4;
  let s = 0;
  let i = 0;
  let j = 0;
  while (i < queryIds.length && j < n) {
    const qid = queryIds[i] as number;
    const rid = view.getUint32(HEADER_BYTES + j * 4, true);
    if (qid === rid) {
      s += (queryWeights[i] as number) * view.getFloat32(wOffset + j * 4, true);
      i++;
      j++;
    } else if (qid < rid) i++;
    else j++;
  }
  return s;
}

/** Pack a query ONCE per search rather than per row. */
function packQuery(query: SparseVec): { ids: Uint32Array; weights: Float32Array } {
  const ids = Object.keys(query)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff)
    .sort((x, y) => x - y);
  const w = new Float32Array(ids.length);
  for (let i = 0; i < ids.length; i++) w[i] = query[String(ids[i])] as number;
  return { ids: Uint32Array.from(ids), weights: w };
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
    // THE-711: `weights_packed` is the packed binary form (see packSparse). The column is RENAMED
    // rather than reused so an older table is structurally detectable — a stale `weights` column
    // cannot be misread as packed bytes, it simply is not there. chunk_sparse is a derived cache,
    // runtime-provisioned and absent from the live store, so dropping an old one costs a reindex
    // of an opt-in feature and nothing else. The ticket says as much: "there is no data to migrate
    // and no append-only chain to extend — the format can simply change."
    const existing = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunk_sparse'")
      .get() as { sql: string | null } | undefined;
    if (existing !== undefined && !existing.sql?.includes("weights_packed"))
      db.exec("DROP TABLE chunk_sparse");
    db.exec(
      "CREATE TABLE IF NOT EXISTS chunk_sparse (chunk_id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, weights_packed BLOB NOT NULL)",
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
    "INSERT INTO chunk_sparse (chunk_id, vault_id, weights_packed) VALUES (?, ?, ?) ON CONFLICT(chunk_id) DO UPDATE SET vault_id = excluded.vault_id, weights_packed = excluded.weights_packed",
  ).run(chunkId, vaultId, packSparse(weights));
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
  /** THE-632: the read ACL, applied BEFORE the top-k cut. Omitted -> no filtering (unchanged).
   *  See the security note on the filter below for why this must not be left to a later stage. */
  isReadable?: (path: string) => boolean,
): SparseHit[] {
  if (k <= 0 || Object.keys(query).length === 0) return [];
  const readable = isReadable ?? (() => true);
  const q = packQuery(query);
  if (q.ids.length === 0) return [];
  let rows: Array<{ chunk_id: string; path: string; weights: Uint8Array }>;
  try {
    rows = db
      .prepare(
        // THE-711(b): `c.content` is NOT selected. Every row in the vault is scanned, but only k
        // survive the top-k cut — pulling content for all of them materialised ~8 MB of note text
        // per query on the live vault (13.5k chunks) purely to throw it away. Content is fetched
        // for the surviving rows only, below.
        "SELECT s.chunk_id AS chunk_id, c.path AS path, s.weights_packed AS weights FROM chunk_sparse s JOIN chunks c ON c.id = s.chunk_id WHERE s.vault_id = ?",
      )
      .all(vaultId) as Array<{ chunk_id: string; path: string; weights: Uint8Array }>;
  } catch {
    return [];
  }
  const scored: Array<{ chunk_id: string; path: string; score: number }> = [];
  for (const r of rows) {
    // THE-632 (security): filter HERE, before scoring and before the top-k slice — not in a later
    // stage. candidate_assembly does filter these out of the returned set, but by then the
    // unreadable hits have already been counted, and any aggregate derived from this array
    // (candidate counts, a diagnostic's candidatesIn) leaks their existence. THE-287 established
    // exactly this for the dense arm; the lexical and sparse arms never received it.
    //
    // This scan is exhaustive (no SQL LIMIT above), so filtering is exact: an unreadable chunk can
    // neither crowd out a readable one nor influence the cut. No over-fetch needed.
    if (!readable(r.path)) continue;
    // THE-711: no JSON.parse, no per-row object. A merge-intersection straight over the stored
    // bytes — this is the whole point of the format change.
    const score = packedDot(q.ids, q.weights, r.weights);
    if (score > 0) scored.push({ chunk_id: r.chunk_id, path: r.path, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, k);
  if (top.length === 0) return [];
  // THE-711(b): one keyed lookup per SURVIVOR, instead of dragging every chunk's content through
  // the scan above. `id` is the chunks PRIMARY KEY, so each is an index seek.
  const contentOf = db.prepare("SELECT content FROM chunks WHERE id = ?");
  return top.map((h) => ({
    chunk_id: h.chunk_id,
    path: h.path,
    content: (contentOf.get(h.chunk_id) as { content: string } | undefined)?.content ?? "",
    score: h.score,
  }));
}
