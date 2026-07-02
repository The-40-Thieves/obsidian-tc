-- THE-291: per-note metadata backing the lexical/metadata index (list_tags, list_properties,
-- find_notes_by_*, search_text acceleration). notes_fts (FTS5, trigram) is runtime-provisioned
-- by ensureNotesFts (search/fts.ts) exactly like vec_chunks — deliberately NOT in this chain,
-- so the versioned migrations apply unchanged on an adapter built without FTS5.
CREATE TABLE IF NOT EXISTS notes (
  vault_id     TEXT NOT NULL,
  path         TEXT NOT NULL,
  title        TEXT NOT NULL,
  tags         TEXT NOT NULL,           -- JSON array (noteTags(raw).all)
  frontmatter  TEXT,                    -- JSON object; NULL when absent or unserializable
  content_hash TEXT NOT NULL,           -- contentHash(raw) — backfill/staleness key
  mtime        INTEGER NOT NULL,
  size         INTEGER NOT NULL,
  indexed_at   INTEGER NOT NULL,
  PRIMARY KEY (vault_id, path)
);
CREATE INDEX IF NOT EXISTS idx_notes_hash ON notes(content_hash);
