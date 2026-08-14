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
    // DIVERGENCE REPAIR. `notes` is DURABLE; `notes_fts` is a DERIVED index, runtime-provisioned and
    // rebuildable from the vault files. So the repair may never delete from `notes` on the strength of
    // an FTS row being absent — that is treating the derived index as the source of truth, and it is the
    // same mistake that produced four data-loss bugs in vault_edges.
    //
    // The divergence is REACHABLE without any corruption: notes_fts is not created by a migration, and
    // upsertNoteRow writes it only when hasFts. One run under OBSIDIAN_TC_DISABLE_FTS=1 (or a single
    // swallowed error below, which caches hasFts=false for the whole connection) leaves `notes`
    // populated and `notes_fts` empty or absent. The old code then read nFts=0, concluded every note was
    // an orphan, and deleted the lot. On indexNote() — the SINGLE-note path — only the one changed note
    // was re-added, so the rest of the vault's metadata stayed gone until a full re-index, silently
    // degrading FTS/lexical search, find_notes_by_*, and the tag read that feeds densification.
    //
    // FTS content cannot be backfilled from `notes` (it stores content_hash, not the body), which is
    // presumably why deletion looked like the only option. It is not: blank the content_hash instead.
    // That marks the note stale, so the next index pass re-reads it from disk and repopulates BOTH
    // tables via the existing backfill path — and the metadata survives in the meantime.
    //
    // Runs unconditionally rather than behind a count check: equal counts do not imply equal SETS, and
    // ensureNotesFts is memoized per connection, so this executes once.
    db.exec(
      "DELETE FROM notes_fts WHERE NOT EXISTS (SELECT 1 FROM notes n WHERE n.vault_id = notes_fts.vault_id AND n.path = notes_fts.path)",
    );
    db.exec(
      "UPDATE notes SET content_hash = '' WHERE NOT EXISTS (SELECT 1 FROM notes_fts f WHERE f.vault_id = notes.vault_id AND f.path = notes.path)",
    );
    // THE-696 INTEGRITY GATE. Everything above establishes that notes_fts EXISTS and that its row
    // set agrees with `notes`. Neither says the inverted index is readable — the live store held a
    // malformed one that passed both and answered queries anyway.
    //
    // Opt-in, not unconditional: integrity-check costs ~0.6s on a 1,146-note trigram index (a
    // rebuild is ~4.2s) and scales with the corpus, which is too much to add to every CLI
    // invocation for a fault this rare. Operators who have been bitten, or who suspect an unclean
    // shutdown, set OBSIDIAN_TC_VERIFY_FTS=1; `doctor --probe` reports it on demand without the
    // env var.
    //
    // On unrepairable damage this returns FALSE rather than true. That routes the query layer to
    // its disk-scan fallback — slower, and correct — instead of serving a corrupt index, which is
    // the failure mode that made this invisible for as long as it was.
    if (process.env.OBSIDIAN_TC_VERIFY_FTS === "1" && !verifyNotesFtsIntegrity(db).ok) {
      if (!repairNotesFts(db).ok) {
        ftsCache.set(db, false);
        return false;
      }
    }
    ftsCache.set(db, true);
    return true;
  } catch {
    ftsCache.set(db, false);
    return false;
  }
}

/** Outcome of an FTS5 integrity probe. `reason` carries SQLite's own message — it is the only
 *  handle an operator has on what went wrong, and it distinguishes a malformed index from an
 *  absent one. */
export type NotesFtsIntegrity = { ok: true } | { ok: false; reason: string };

/**
 * THE-696 — is notes_fts SOUND, not merely PRESENT?
 *
 * `ensureNotesFts` provisions with CREATE VIRTUAL TABLE IF NOT EXISTS, which is an EXISTENCE test.
 * A malformed table exists, so the guard returns true and never rebuilds. The live store carried a
 * malformed inverted index that kept answering MATCH queries with plausible counts; it was found
 * only because an unrelated `.backup` ran PRAGMA quick_check on the way past.
 *
 * Result counts cannot substitute for this check. Measured on the live 252MB store: a healthy index
 * and a deliberately corrupted copy of it returned IDENTICAL counts for all five terms tried
 * (obsidian 363, decision 587, aedras 144, memory 257, vault 545 — delta 0 on every one). A corrupt
 * inverted index returns whatever survives in its b-tree, and that can be everything you asked for.
 *
 * Costs ~0.6s on a 1,146-note trigram index and scales with corpus size, which is why it is opt-in
 * (see ensureNotesFts) rather than paid on every boot.
 *
 * Never throws: a diagnostic that dies while diagnosing is useless exactly when it is needed.
 */
export function verifyNotesFtsIntegrity(db: Database): NotesFtsIntegrity {
  try {
    db.exec("INSERT INTO notes_fts(notes_fts) VALUES('integrity-check')");
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error)?.message ?? String(e) };
  }
}

/**
 * Rebuild the notes_fts inverted index from its shadow content table, then RE-VERIFY.
 *
 * Safe by construction: notes_fts is a derived index (the same reasoning as the divergence repair
 * in ensureNotesFts), so a rebuild loses nothing that is not reconstructible. Verified against real
 * corruption — malformed -> rebuild -> integrity-check passes, with the MATCH count unchanged.
 *
 * Returns the re-verification, never a bare success: `rebuild` reports no error of its own for an
 * index it failed to fully reconstruct, so claiming repair without re-checking would reintroduce
 * exactly the unverified-status-field defect this ticket is about.
 */
export function repairNotesFts(db: Database): NotesFtsIntegrity {
  try {
    db.exec("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')");
  } catch (e) {
    return { ok: false, reason: `rebuild failed: ${(e as Error)?.message ?? String(e)}` };
  }
  return verifyNotesFtsIntegrity(db);
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
  const parsed = parseNote(raw, path);
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
    tagsJson: JSON.stringify(noteTags(raw, path).all),
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
