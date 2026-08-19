// THE-628 (first PR): the note-level (leaf) summary tier's data-access layer over `note_summaries`
// (migration 20260819_001) — the row-level CRUD the index-time summarizer needs, plus a brute-force
// semantic search over summary embeddings for the DARK retrieval candidate stream
// (graph_search_stages/candidate_assembly.ts). "Brute-force" is deliberate, not a shortcut: one row
// per NOTE (not per chunk) means this scan is proportional to note count, which stays small enough
// that a dedicated vec0 partition (mirroring vec_chunks in search/vec.ts) is unwarranted complexity
// for a first, dark PR — see the research brief's cost/throughput analysis. A vec0-backed variant is
// a natural follow-up if a vault's note count ever makes the brute-force scan the bottleneck.
import { tableExists } from "../db/introspect";
import type { Database } from "../db/types";
import { contentHash } from "../vault/paths";
import { cosineBatch } from "./native";
import { blobToFloats, floatBlob } from "./vec";

/** Stable, content-independent candidate id for a note's summary — the Candidate-stream analogue
 *  of chunkId() (search/indexing/note-plan.ts). Prefixed distinctly from real chunk ids ("chk_")
 *  so a summary candidate can never collide with (or be mistaken for) a chunk id downstream. */
export function noteSummaryId(vaultId: string, path: string): string {
  return `sum_${contentHash(`${vaultId} ${path}`).slice(0, 24)}`;
}

export interface NoteSummaryRecord {
  path: string;
  contentHash: string;
  summary: string;
  model: string;
  embedding?: number[];
  embeddingModel?: string;
  createdAt: number;
}

/** Does this cache.db carry the note_summaries table (migration 20260819_001)? Guarded the same
 *  way every optional-table probe in this codebase is (tableExists), so a pre-migration db or a
 *  bare fixture degrades to "no summaries" rather than throwing "no such table" from inside a
 *  search request. */
export function hasNoteSummaries(db: Database): boolean {
  return tableExists(db, "note_summaries");
}

/** The stored content_hash for a note's CURRENT summary row, or null when none exists. The
 *  index-time summarizer's resume/skip check: a note whose content_hash already matches is not
 *  re-summarized (mirrors computeNotePlan's `ex.content_hash !== d.contentHash` gate). */
export function existingSummaryHash(db: Database, vaultId: string, path: string): string | null {
  const row = db
    .prepare("SELECT content_hash FROM note_summaries WHERE vault_id = ? AND path = ?")
    .get(vaultId, path) as { content_hash: string } | undefined;
  return row?.content_hash ?? null;
}

/** Upsert a note's summary row — one CURRENT row per (vault_id, path), replacing whatever was
 *  there (see the migration header for why this is a replace, not a history table). */
export function upsertNoteSummary(db: Database, vaultId: string, rec: NoteSummaryRecord): void {
  db.prepare(
    `INSERT INTO note_summaries (vault_id, path, content_hash, summary, model, embedding, embedding_model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(vault_id, path) DO UPDATE SET
       content_hash = excluded.content_hash,
       summary = excluded.summary,
       model = excluded.model,
       embedding = excluded.embedding,
       embedding_model = excluded.embedding_model,
       created_at = excluded.created_at`,
  ).run(
    vaultId,
    rec.path,
    rec.contentHash,
    rec.summary,
    rec.model,
    rec.embedding ? floatBlob(rec.embedding) : null,
    rec.embeddingModel ?? null,
    rec.createdAt,
  );
}

export interface SummaryHit {
  /** Synthetic candidate id — see noteSummaryId(). Never a real chunk_id. */
  chunk_id: string;
  path: string;
  content: string;
  score: number;
}

interface SummaryRow {
  path: string;
  summary: string;
  embedding: Uint8Array;
}

/** Brute-force cosine search over embedded note summaries, ACL-filtered exactly like
 *  semantic.ts's fallback branch (isReadable applied BEFORE scoring, so an unreadable note's
 *  summary is never scored — let alone returned). Rows with no embedding yet (summarized but not
 *  embedded, e.g. an embed-provider outage after a successful gateway call) are excluded, same as
 *  they would be from vec0 semantic search over chunks. */
export function searchNoteSummaries(
  db: Database,
  vaultId: string,
  queryVec: number[],
  opts: { k: number; isReadable?: (path: string) => boolean; minScore?: number },
): SummaryHit[] {
  if (opts.k <= 0 || !hasNoteSummaries(db)) return [];
  const readable = opts.isReadable ?? (() => true);
  const rows = (
    db
      .prepare(
        "SELECT path, summary, embedding FROM note_summaries WHERE vault_id = ? AND embedding IS NOT NULL",
      )
      .all(vaultId) as SummaryRow[]
  ).filter((r) => readable(r.path));
  if (rows.length === 0) return [];
  const dim = queryVec.length;
  const same = rows.filter((r) => r.embedding.byteLength === dim * 4);
  if (same.length === 0) return [];
  const flat = new Float32Array(same.length * dim);
  same.forEach((r, i) => {
    flat.set(blobToFloats(r.embedding), i * dim);
  });
  const queryF32 = Float32Array.from(queryVec);
  const scores = cosineBatch(queryF32, flat, dim);
  const hits: SummaryHit[] = [];
  same.forEach((r, i) => {
    const score = scores[i] ?? 0;
    if (opts.minScore !== undefined && score < opts.minScore) return;
    hits.push({
      chunk_id: noteSummaryId(vaultId, r.path),
      path: r.path,
      content: r.summary,
      score,
    });
  });
  // Total order: score descending, then path — same tie-break discipline as semantic.ts (THE-582),
  // so two identically-scored summaries resolve deterministically rather than by table-scan order.
  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return hits.slice(0, opts.k);
}
