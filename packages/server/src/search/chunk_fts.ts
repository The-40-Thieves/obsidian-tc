// Chunk-level FTS5 (BM25) lexical index — THE-73 hybrid retrieval. Mirrors the notes_fts pattern
// (fts.ts) but at CHUNK grain, because graph_search fuses on chunk_id: the dense seeds and the graph
// expansion are chunk-grained, so the lexical RRF stream must be too. Uses the porter/unicode61
// tokenizer for relevance ranking (notes_fts is trigram, tuned for substring candidate-generation,
// not BM25 relevance). chunk_fts is DERIVABLE from chunks.content (already secret-gated — flagged
// chunks never become chunks), so a row-count divergence rebuilds it wholesale from chunks; no
// per-write sync-detector is needed. Runtime-provisioned like notes_fts/vec_chunks: a cache.db
// written under an FTS5-less adapter stays openable under one with FTS5.
import { err } from "@the-40-thieves/obsidian-tc-shared";
import type { Database } from "../db/types";
import { enrichChunkText } from "./chunk";

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
export function ensureChunkFts(
  db: Database,
  /** THE-408: `enrich` is embeddings.chunkContext, threaded by the INDEXER call sites (the only
   *  src callers). When set, a divergence-rebuild reconstructs the THE-406 enriched text instead
   *  of raw chunk content, so the BM25 stream can never silently de-enrich under a live enriched
   *  index. Callers that cannot know the flag omit it and get the raw rebuild — correct for
   *  legacy raw indexes, which are the only place a flagless rebuild occurs. */
  opts: { now?: () => number; enrich?: boolean } = {},
): boolean {
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
    // THE-711 follow-up: chunk_fts is CONTENTLESS. It stores only the inverted index; the text it
    // indexed is not kept a second time. Measured before the change: `chunk_fts_content` was
    // 14.5 MB of a 226 MB cache.db, holding a copy of text that already lives in `chunks.content`.
    //
    // CONTENTLESS, NOT EXTERNAL-CONTENT, and that is forced rather than chosen. External content
    // (`content='chunks'`) reads a column back out of the content table — but under THE-408 the
    // indexed text is `enrichChunkText(path, crumbs, content)`, a DERIVED string that is not any
    // column of `chunks`. Pointing FTS5 at `chunks` would silently re-read raw content and
    // de-enrich the index. Contentless never reads the text back, so enrichment survives.
    //
    // The consequence that shapes the rest of this file: a contentless table's declared columns
    // CANNOT be read or filtered — `SELECT ... WHERE vault_id = ?` returns nothing, silently. So
    // identity and scoping come from a join to `chunks` on rowid, and every write path keys on
    // rowid. `contentless_delete=1` (FTS5 3.43+; the runtimes here are 3.53) is what makes
    // `DELETE ... WHERE rowid = ?` legal at all.
    migrateChunkFtsShape(db);
    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(content, content='', contentless_delete=1, tokenize='porter unicode61')",
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
      db.exec("DELETE FROM chunk_fts");
      if (opts.enrich === true) {
        // Enriched rebuild. `rowid` is selected explicitly and written as the FTS rowid: it is the
        // ONLY join key a contentless index has, so a rebuild that let SQLite assign rowids would
        // produce an index that matches correctly and then joins to the wrong chunks.
        // THE-408: an enriched index rebuilds ENRICHED — reconstruct the THE-406 embed/BM25 text
        // from path + headings + content in JS (the SQL-only path cannot parse the headings JSON).
        const rows = db
          .prepare("SELECT rowid, path, headings, content FROM chunks")
          .all() as Array<{
          rowid: number;
          path: string;
          headings: string;
          content: string;
        }>;
        const ins = db.prepare("INSERT INTO chunk_fts (rowid, content) VALUES (?, ?)");
        for (const r of rows) {
          let crumbs: string[] = [];
          try {
            crumbs = JSON.parse(r.headings || "[]") as string[];
          } catch {
            // malformed headings metadata degrades to a title-only prefix, never a failed rebuild
          }
          ins.run(r.rowid, enrichChunkText(r.path, crumbs, r.content));
        }
      } else {
        db.exec("INSERT INTO chunk_fts (rowid, content) SELECT rowid, content FROM chunks");
      }
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
export function upsertChunkFtsRow(db: Database, rowid: number, content: string): void {
  db.prepare("DELETE FROM chunk_fts WHERE rowid = ?").run(rowid);
  db.prepare("INSERT INTO chunk_fts (rowid, content) VALUES (?, ?)").run(rowid, content);
}

/**
 * Delete a chunk's FTS row, BY ROWID.
 *
 * The signature is the safety mechanism, not a style choice. A contentless index can only be
 * deleted from by rowid, and the rowid belongs to the `chunks` row — so once that row is gone the
 * entry is unreachable forever. The delete path in persist-note-plan.ts removed the chunk BEFORE
 * calling this, which under a chunk-id signature would have compiled, run, and silently orphaned
 * an index entry.
 *
 * Taking a `number` makes that unrepresentable: a caller cannot obtain a rowid after deleting the
 * row it belongs to, so the compiler enforces the ordering that a comment could only request.
 *
 * Orphans are not a cosmetic problem here. `ensureChunkFts` rebuilds whenever
 * `COUNT(chunks) !== COUNT(chunk_fts)`, so a single orphan makes those counts disagree
 * permanently and triggers a FULL reindex of every chunk on every open — a silent, unbounded
 * performance regression rather than a missing search result.
 */
export function deleteChunkFtsRow(db: Database, rowid: number): void {
  db.prepare("DELETE FROM chunk_fts WHERE rowid = ?").run(rowid);
}

/**
 * Drop a pre-THE-711 chunk_fts so the contentless definition can replace it.
 *
 * `CREATE VIRTUAL TABLE IF NOT EXISTS` is a no-op against an existing table of the OLD shape, so
 * without this an upgraded install would keep its 4-column content-storing index, and every write
 * below (which addresses `rowid`/`content` only) would fail against it.
 *
 * Detection reads the stored DDL rather than probing behaviour: a contentless table is exactly one
 * whose CREATE statement carries `contentless_delete`. Dropping an FTS5 table drops its shadow
 * tables with it; `ensureChunkFts`'s existing count-divergence check then rebuilds the index,
 * because an empty chunk_fts can never match a non-empty chunks.
 *
 * Note the freed pages do NOT shrink the file on their own — they go to the freelist and are
 * reused. Reclaiming disk needs a VACUUM, which this deliberately does not run: a VACUUM of a
 * 226 MB database inside a lazy provisioning path would be a startup stall nobody asked for.
 */
function migrateChunkFtsShape(db: Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunk_fts'")
    .get() as { sql: string | null } | undefined;
  if (row === undefined) return; // no table yet — the CREATE below makes a contentless one
  if (row.sql?.includes("contentless_delete")) return; // already migrated
  db.exec("DROP TABLE chunk_fts");
  // The shape just changed under any handle that already cached a verdict. Only a positive verdict
  // is ever cached (see assertContentlessChunkFts), so this drop can only invalidate a stale
  // "contentless" answer — which cannot happen, since we only get here when it was NOT contentless.
  // Cleared anyway: the cost is nothing and the invariant should not depend on that argument.
  contentlessCache.delete(db);
}

/** Handles already proven to hold a post-THE-711 contentless `chunk_fts`. Only the POSITIVE verdict
 *  is cached: a legacy shape throws, and a handle that repairs itself mid-life must be able to
 *  answer differently on its next call. */
const contentlessCache = new WeakMap<Database, boolean>();

/**
 * THE-750: refuse to run the lexical stream against a pre-THE-711 `chunk_fts`, rather than
 * returning wrong rows.
 *
 * `bm25Chunks` joins `chunks.rowid = chunk_fts.rowid`, which is only meaningful for the contentless
 * table whose rowids are deliberately aligned. A 4-column content-storing `chunk_fts` has its own
 * independent rowids, so that join does not fail — it **silently pairs FTS hits to the wrong
 * chunks**. Measured on a real pre-THE-711 cache: 8,933 of 13,451 rows "joined" (all mis-paired)
 * and 4,897 dropped, which cost the fused arm ~0.13 nDCG@10 while the pure-dense arm — which never
 * touches FTS — reproduced byte-identically. A one-sided degradation with no error is exactly the
 * shape that reads as a retrieval finding; it cost a full session before being traced.
 *
 * `ensureChunkFts` repairs this, but it is reachable ONLY from the write path
 * (`indexing/index-vault.ts`, `indexing/index-note.ts`). A read-only consumer — the eval harness,
 * `doctor --probe`, anything opening an archived or copied cache — can never trigger the repair,
 * so for those callers the only honest options are "refuse" and "return wrong rows".
 *
 * Throws rather than returning empty: an empty lexical arm is itself a plausible-looking result
 * (a query that matches nothing), so degrading silently to `[]` would re-create the same class of
 * bug one layer up. A missing table is NOT an error here — callers gate on `ensureChunkFts`'s
 * boolean, and provisioning is lazy by design.
 */
function assertContentlessChunkFts(db: Database): void {
  if (contentlessCache.get(db) === true) return;
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunk_fts'")
    .get() as { sql: string | null } | undefined;
  if (row === undefined) return; // no table — not this function's problem
  if (row.sql?.includes("contentless_delete") === true) {
    contentlessCache.set(db, true);
    return;
  }
  throw err.internal(
    "chunk_fts is the pre-THE-711 content-storing shape, whose rowids are NOT aligned to chunks.rowid. " +
      "The lexical (BM25) stream would silently return rows joined to the WRONG chunks, so it is refused. " +
      "Re-index this cache to rebuild chunk_fts (`obsidian-tc index <config>`); the repair runs on the " +
      "write path only, so a read-only consumer cannot perform it.",
    { table: "chunk_fts", expected: "contentless_delete", remedy: "re-index" },
  );
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
/**
 * THE-632 (security): `isReadable` applies the read ACL BEFORE the top-k cut.
 *
 * candidate_assembly does filter unreadable hits out of the returned set, but by then they have
 * already been counted and have already occupied slots in this array. Two consequences, and the
 * first is a disclosure bug rather than a recall one:
 *
 *   - any aggregate derived from this array leaks the existence of unreadable content. A
 *     diagnostic reporting candidate counts turns into a cross-ACL membership oracle: query a rare
 *     term, watch the count move, learn the term appears in a note you cannot read.
 *   - unreadable chunks crowd out readable ones inside the SQL LIMIT, so a caller can lose real
 *     hits to notes they are not allowed to see.
 *
 * THE-287 established exactly this for the dense arm (semantic.ts over-fetches, then filters, then
 * falls back to an exhaustive scan). The lexical and sparse arms never received the same treatment.
 *
 * FTS ranks and limits in SQL, so the fix is the same shape: over-fetch by the THE-287 factor,
 * filter in JS, then cut.
 *
 * The residual, stated honestly, because an earlier draft of this comment called it "a recall
 * limit, not a leak" as though that were structural. It is not — it is contingent on corpus
 * statistics, and it is worth re-checking if either input moves:
 *
 *   GUARANTEED unconditionally: an unreadable chunk is never RETURNED. The result set contains
 *   only rows the caller may read, whatever the corpus looks like. That part fails closed.
 *
 *   NOT GUARANTEED: the returned LENGTH. It is min(k, readable rows inside the window), so it
 *   depends on how many EXCLUDED rows outrank the caller's — an interference channel on the count,
 *   with no unreadable content in it.
 *
 * The threshold, corrected. A first version of this note computed the window as a share of the
 * whole corpus and concluded "safe today". Wrong denominator: what matters is the hidden fraction
 * of the top-F MATCH prefix, not of the vault. With F = 20k + 50, underfill begins once that
 * fraction exceeds 1 - k/F — 95.38% at k=30, 96% at k=10, 98.57% at k=1. Cross-vendor review
 * reproduced the boundary directly on this query shape: at k=1 (F=70), 69 higher-scoring hidden
 * matches return the readable row, 70 return nothing. One row's existence flips the length.
 *
 * chunkFtsMatch joins terms with OR, so filling F still takes a corpus-common term, which bounds
 * how casually this is reached. It does NOT dismiss it: the row that crosses the boundary can
 * itself be the note whose existence is in question. Treat this as a live residual (THE-695),
 * not as a closed case, and re-derive the sum rather than inheriting this verdict if k, the
 * over-fetch factor, or the OR-vs-AND shape of the MATCH ever changes.
 */
export function bm25Chunks(
  db: Database,
  vaultId: string,
  query: string,
  k: number,
  isReadable?: (path: string) => boolean,
  /** THE-695: an `acl_path_members` set_id. When present the read filter is applied IN SQL and the
   *  over-fetch is not needed at all — the returned LENGTH stops depending on how many
   *  higher-scoring hidden rows exist, which is the channel this closes. Absent (no substrate, or
   *  a pre-migration cache.db) falls back to the over-fetch path below, byte-identical to before. */
  aclSetId?: number,
): LexicalHit[] {
  if (k <= 0) return [];
  const match = chunkFtsMatch(query);
  if (match === null) return [];
  // THE-750: DELIBERATELY outside the try below. That catch turns every failure into `[]`, so a
  // refusal raised inside it would be swallowed into exactly the silence this guard exists to end.
  assertContentlessChunkFts(db);
  const readable = isReadable ?? (() => true);
  // Same constant as semantic.ts's KNN over-fetch, deliberately — one number to reason about when
  // asking "how hidden can a vault be before an arm underfills?".
  const overFetch = isReadable ? k * 20 + 50 : k;
  try {
    if (aclSetId !== undefined) {
      // Exact: LIMIT k over the already-filtered set, so there is no window to fall outside of.
      return db
        .prepare(
          // Every identity/scoping column now comes from `chunks`, never from chunk_fts: a
          // contentless index returns nothing for its declared columns, so `chunk_fts.vault_id`
          // would have silently matched zero rows rather than erroring.
          "SELECT chunks.id AS chunk_id, chunks.path AS path, chunks.content AS content, bm25(chunk_fts) AS rank FROM chunk_fts JOIN chunks ON chunks.rowid = chunk_fts.rowid JOIN acl_path_members a ON a.set_id = ? AND a.path = chunks.path WHERE chunks.vault_id = ? AND chunk_fts MATCH ? ORDER BY rank LIMIT ?",
        )
        .all(aclSetId, vaultId, match, k) as LexicalHit[];
    }
    // THE-406: match/rank on chunk_fts.content (context-enriched when embeddings.chunkContext is
    // on) but RETURN chunks.content — the raw display text — so enrichment never leaks into
    // search output. Rows are 1:1 by construction (written in the same transaction).
    return db
      .prepare(
        "SELECT chunks.id AS chunk_id, chunks.path AS path, chunks.content AS content, bm25(chunk_fts) AS rank FROM chunk_fts JOIN chunks ON chunks.rowid = chunk_fts.rowid WHERE chunks.vault_id = ? AND chunk_fts MATCH ? ORDER BY rank LIMIT ?",
      )
      .all(vaultId, match, overFetch)
      .filter((r) => readable((r as LexicalHit).path))
      .slice(0, k) as LexicalHit[];
  } catch {
    return [];
  }
}
