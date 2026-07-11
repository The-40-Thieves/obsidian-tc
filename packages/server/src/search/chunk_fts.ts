// Chunk-level FTS5 (BM25) lexical index — THE-73 hybrid retrieval. Mirrors the notes_fts pattern
// (fts.ts) but at CHUNK grain, because graph_search fuses on chunk_id: the dense seeds and the graph
// expansion are chunk-grained, so the lexical RRF stream must be too. Uses the porter/unicode61
// tokenizer for relevance ranking (notes_fts is trigram, tuned for substring candidate-generation,
// not BM25 relevance). chunk_fts is DERIVABLE from chunks.content (already secret-gated — flagged
// chunks never become chunks), so a row-count divergence rebuilds it wholesale from chunks; no
// per-write sync-detector is needed. Runtime-provisioned like notes_fts/vec_chunks: a cache.db
// written under an FTS5-less adapter stays openable under one with FTS5.
import type { Database } from "../db/types";

const chunkFtsCache = new WeakMap<Database, boolean>();

function chunksTableExists(db: Database): boolean {
  return (
    db
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'chunks'")
      .get() !== undefined
  );
}

/**
 * Provision chunk_fts (FTS5, porter+unicode61) on this connection. Returns false when the adapter
 * lacks FTS5 or OBSIDIAN_TC_DISABLE_FTS=1 — callers then skip chunk_fts writes and the lexical
 * retrieval stream no-ops (graph_search degrades to dense seed + graph expansion, the pre-THE-73
 * behaviour). Records a pseudo-migration row like notes_fts/vec0. chunk_fts is fully derivable from
 * chunks, so on a row-count divergence (first FTS-capable open of an older index, or writes made
 * under hasFts=false) it is rebuilt wholesale from chunks.content — no per-write sync-detector.
 */
export function ensureChunkFts(db: Database, opts: { now?: () => number } = {}): boolean {
  const cached = chunkFtsCache.get(db);
  if (cached !== undefined) return cached;
  if (process.env.OBSIDIAN_TC_DISABLE_FTS === "1") {
    chunkFtsCache.set(db, false);
    return false;
  }
  if (!chunksTableExists(db)) {
    chunkFtsCache.set(db, false);
    return false;
  }
  try {
    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(chunk_id UNINDEXED, vault_id UNINDEXED, path UNINDEXED, content, tokenize='porter unicode61')",
    );
    const now = opts.now ?? Date.now;
    const version = "20260710_001_chunk_fts";
    const recorded = db
      .prepare("SELECT version FROM schema_migrations WHERE version = ?")
      .get(version);
    if (!recorded) {
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at, obsidian_tc_version, duration_ms, checksum) VALUES (?, ?, ?, ?, ?)",
      ).run(version, now(), "search-runtime", 0, "fts5:porter");
    }
    const nChunks = (db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
    const nFts = (db.prepare("SELECT COUNT(*) AS n FROM chunk_fts").get() as { n: number }).n;
    if (nChunks !== nFts) {
      // THE-406 caveat: this wholesale rebuild reconstructs from RAW chunks.content — it cannot
      // know the embeddings.chunkContext flag. With enrichment on, a divergence-rebuild holds
      // un-enriched text until each row is next re-embedded (or the flag is flipped off+on,
      // which re-hashes everything). Acceptable while the flag is experimental; make the rebuild
      // enrichment-aware before flipping the default.
      db.exec("DELETE FROM chunk_fts");
      db.exec(
        "INSERT INTO chunk_fts (chunk_id, vault_id, path, content) SELECT id, vault_id, path, content FROM chunks",
      );
    }
    chunkFtsCache.set(db, true);
    return true;
  } catch {
    chunkFtsCache.set(db, false);
    return false;
  }
}

/**
 * Replace a chunk's FTS row (FTS5 has no UPSERT; delete-then-insert). Caller owns the transaction
 * and the hasChunkFts guard.
 */
export function upsertChunkFtsRow(
  db: Database,
  chunkId: string,
  vaultId: string,
  path: string,
  content: string,
): void {
  db.prepare("DELETE FROM chunk_fts WHERE chunk_id = ?").run(chunkId);
  db.prepare("INSERT INTO chunk_fts (chunk_id, vault_id, path, content) VALUES (?, ?, ?, ?)").run(
    chunkId,
    vaultId,
    path,
    content,
  );
}

/** Delete a chunk's FTS row. Caller owns the transaction and the hasChunkFts guard. */
export function deleteChunkFtsRow(db: Database, chunkId: string): void {
  db.prepare("DELETE FROM chunk_fts WHERE chunk_id = ?").run(chunkId);
}

/** Tokenise free text the way the lexical stream consumes it: lowercase, split on
 *  non-alphanumerics, drop empties. Shared by chunkFtsMatch and the THE-391 specificity signal
 *  so both sides of adaptive RRF agree on what a "query term" is. */
export function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/**
 * Build an FTS5 MATCH expression from free text: split into alphanumeric terms, quote each (so FTS
 * operators / punctuation in the query are neutralised), OR-join for any-term BM25 matching. Returns
 * null when the query has no usable term (the caller then skips the lexical stream).
 */
export function chunkFtsMatch(query: string): string | null {
  const terms = queryTerms(query);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(" OR ");
}

export interface LexicalHit {
  chunk_id: string;
  path: string;
  content: string;
  rank: number;
}

/**
 * BM25-ranked chunk hits for a free-text query (chunk grain). Best-first (sqlite bm25 is
 * negative-better, so ORDER BY rank ascending). Returns [] when chunk_fts is absent (FTS-less
 * adapter or un-provisioned index) or the query has no usable term — the caller's lexical stream
 * then contributes nothing and graph_search behaves as dense-only. `rank` is the raw bm25 score
 * (RRF ranks by position, not this value; kept for debugging / score_merge).
 */
export function bm25Chunks(db: Database, vaultId: string, query: string, k: number): LexicalHit[] {
  if (k <= 0) return [];
  const match = chunkFtsMatch(query);
  if (match === null) return [];
  try {
    // THE-406: match/rank on chunk_fts.content (context-enriched when embeddings.chunkContext is
    // on) but RETURN chunks.content — the raw display text — so enrichment never leaks into
    // search output. Rows are 1:1 by construction (written in the same transaction).
    return db
      .prepare(
        "SELECT chunk_fts.chunk_id AS chunk_id, chunk_fts.path AS path, chunks.content AS content, bm25(chunk_fts) AS rank FROM chunk_fts JOIN chunks ON chunks.id = chunk_fts.chunk_id WHERE chunk_fts.vault_id = ? AND chunk_fts MATCH ? ORDER BY rank LIMIT ?",
      )
      .all(vaultId, match, k) as LexicalHit[];
  } catch {
    return [];
  }
}
