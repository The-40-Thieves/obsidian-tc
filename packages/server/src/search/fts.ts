// THE-291 — notes-table + FTS5 write helpers. The notes table (versioned migration
// 20260702_001) carries per-note metadata; notes_fts is a runtime-provisioned FTS5 virtual
// table (trigram tokenizer, so candidate generation is a SUPERSET of the substring matches
// search_text promises — unicode61 would silently lose recall). All FTS writes are app-managed
// behind the ensureNotesFts capability probe, mirroring ensureVecChunks/sqlite-vec: a cache.db
// written under an FTS5-capable adapter stays openable under one without it.
import type { Database } from "../db/types";
import { parseNote } from "../vault/frontmatter";
import { contentHash } from "../vault/paths";
import { noteTags } from "../vault/tags";

const ftsCache = new WeakMap<Database, boolean>();
const notesCache = new WeakMap<Database, boolean>();

/** tableExists, cached per connection (indexNote runs per write). */
export function hasNotesTable(db: Database): boolean {
  const cached = notesCache.get(db);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    ok =
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notes'").get() !==
      undefined;
  } catch {
    ok = false;
  }
  notesCache.set(db, ok);
  return ok;
}

/**
 * Provision notes_fts (FTS5, trigram) on this connection. Returns false when the adapter lacks
 * FTS5 or OBSIDIAN_TC_DISABLE_FTS=1 — callers then skip all FTS writes and the query layer
 * falls back to disk scans (the portable floor). Records a pseudo-migration row like vec0.
 * SYNC DETECTOR: writes made under hasFts=false update notes but not notes_fts; on the next
 * FTS-capable open the row counts diverge, so notes rows lacking an fts row are dropped here —
 * the boot reconcile's backfill (content_hash mismatch/missing row) then rebuilds both.
 */
export function ensureNotesFts(db: Database, opts: { now?: () => number } = {}): boolean {
  const cached = ftsCache.get(db);
  if (cached !== undefined) return cached;
  if (process.env.OBSIDIAN_TC_DISABLE_FTS === "1") {
    ftsCache.set(db, false);
    return false;
  }
  if (!hasNotesTable(db)) {
    ftsCache.set(db, false);
    return false;
  }
  try {
    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(vault_id UNINDEXED, path, title, content, tokenize='trigram')",
    );
    const now = opts.now ?? Date.now;
    const version = "20260702_002_notes_fts";
    const recorded = db
      .prepare("SELECT version FROM schema_migrations WHERE version = ?")
      .get(version);
    if (!recorded) {
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at, obsidian_tc_version, duration_ms, checksum) VALUES (?, ?, ?, ?, ?)",
      ).run(version, now(), "m2-runtime", 0, "fts5:trigram");
    }
    const nNotes = (db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number }).n;
    const nFts = (db.prepare("SELECT COUNT(*) AS n FROM notes_fts").get() as { n: number }).n;
    if (nNotes !== nFts) {
      db.exec(
        "DELETE FROM notes WHERE NOT EXISTS (SELECT 1 FROM notes_fts f WHERE f.vault_id = notes.vault_id AND f.path = notes.path)",
      );
      db.exec(
        "DELETE FROM notes_fts WHERE NOT EXISTS (SELECT 1 FROM notes n WHERE n.vault_id = notes_fts.vault_id AND n.path = notes_fts.path)",
      );
    }
    ftsCache.set(db, true);
    return true;
  } catch {
    ftsCache.set(db, false);
    return false;
  }
}

export interface NoteRecord {
  path: string;
  title: string;
  tagsJson: string;
  frontmatterJson: string | null;
  contentHash: string;
  mtime: number;
  size: number;
  /** Raw note normalized to \n with secret-flagged chunk contents excised. */
  ftsContent: string;
}

/**
 * Build a note's metadata record from its raw content. `flagged` are the secret-gated chunk
 * contents (already \n-joined body lines) — they are excised from the FTS copy so credentials
 * never enter cache.db via this second copy (critique: derive from RAW, not from chunks, so
 * heading lines and mid-line hard-splits cannot create silent false negatives).
 */
export function buildNoteRecord(
  path: string,
  raw: string,
  flagged: string[],
  stat: { mtime: number; size: number } | null,
  ts: number,
): NoteRecord {
  const parsed = parseNote(raw);
  const fmTitle =
    parsed.frontmatter && typeof parsed.frontmatter.title === "string"
      ? parsed.frontmatter.title
      : null;
  const base = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
  let frontmatterJson: string | null = null;
  try {
    frontmatterJson = parsed.frontmatter ? JSON.stringify(parsed.frontmatter) : null;
  } catch {
    frontmatterJson = null; // cyclic/aliased YAML — metadata queries fall back for this note
  }
  let ftsContent = raw.replace(/\r\n/g, "\n");
  for (const c of flagged) if (c.length > 0) ftsContent = ftsContent.split(c).join("");
  return {
    path,
    title: fmTitle ?? base,
    tagsJson: JSON.stringify(noteTags(raw).all),
    frontmatterJson,
    contentHash: contentHash(raw),
    mtime: stat?.mtime ?? ts,
    size: stat?.size ?? Buffer.byteLength(raw, "utf8"),
    ftsContent,
  };
}

/** Upsert the notes row (+ notes_fts when enabled). Caller owns the transaction. */
export function upsertNoteRow(
  db: Database,
  vaultId: string,
  rec: NoteRecord,
  hasFts: boolean,
  ts: number,
): void {
  db.prepare(
    "INSERT INTO notes (vault_id, path, title, tags, frontmatter, content_hash, mtime, size, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(vault_id, path) DO UPDATE SET title = excluded.title, tags = excluded.tags, frontmatter = excluded.frontmatter, content_hash = excluded.content_hash, mtime = excluded.mtime, size = excluded.size, indexed_at = excluded.indexed_at",
  ).run(
    vaultId,
    rec.path,
    rec.title,
    rec.tagsJson,
    rec.frontmatterJson,
    rec.contentHash,
    rec.mtime,
    rec.size,
    ts,
  );
  if (hasFts) {
    db.prepare("DELETE FROM notes_fts WHERE vault_id = ? AND path = ?").run(vaultId, rec.path);
    db.prepare("INSERT INTO notes_fts (vault_id, path, title, content) VALUES (?, ?, ?, ?)").run(
      vaultId,
      rec.path,
      rec.title,
      rec.ftsContent,
    );
  }
}

/** Delete a note's metadata + FTS rows. Caller owns the transaction. */
export function deleteNoteRow(db: Database, vaultId: string, path: string, hasFts: boolean): void {
  db.prepare("DELETE FROM notes WHERE vault_id = ? AND path = ?").run(vaultId, path);
  if (hasFts)
    db.prepare("DELETE FROM notes_fts WHERE vault_id = ? AND path = ?").run(vaultId, path);
}

/** The stored content_hash for a note, or null. Backfill/staleness check. */
export function noteRowHash(db: Database, vaultId: string, path: string): string | null {
  const row = db
    .prepare("SELECT content_hash FROM notes WHERE vault_id = ? AND path = ?")
    .get(vaultId, path) as { content_hash: string } | undefined;
  return row?.content_hash ?? null;
}

/** FTS MATCH-safe phrase: wrap in double quotes, double embedded quotes. */
export function escapeFtsQuery(q: string): string {
  return `"${q.replace(/"/g, '""')}"`;
}

/**
 * BM25-ranked candidate paths for a substring query (trigram superset; caller re-verifies
 * against the raw files). Returns null when the query is under the trigram minimum (3 chars).
 * Consumed by searchTextIndexed (THE-291 part 3B).
 */
export function ftsCandidates(
  db: Database,
  vaultId: string,
  query: string,
  cap: number,
): Array<{ path: string; rank: number }> | null {
  if ([...query].length < 3) return null;
  return db
    .prepare(
      "SELECT path, bm25(notes_fts) AS rank FROM notes_fts WHERE vault_id = ? AND notes_fts MATCH ? ORDER BY rank LIMIT ?",
    )
    .all(vaultId, escapeFtsQuery(query), cap) as Array<{ path: string; rank: number }>;
}
