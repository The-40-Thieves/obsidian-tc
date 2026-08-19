-- 20260819_001_note_summaries.sql
-- THE-628 (first PR): the note-level (leaf) summary tier for hierarchical/global retrieval.
-- Ships DARK — behind retrieval.summaries.enabled (default false) — as the mechanism only; it does
-- not claim a quality result and does not enable itself. See docs/plans (THE-628 research brief)
-- for the RAPTOR-style two-level design this is the first of two tiers for (cluster-level summaries
-- are a follow-up ticket, not built here).
--
-- One CURRENT row per (vault_id, path), exactly like the `notes` table (20260702_001) it mirrors —
-- NOT a history table. `content_hash` is the SAME per-note hash `notes.content_hash` carries (the
-- note's raw content, not a chunk's), so a summary is invalidated by precisely the signal that
-- already drives re-embedding for the rest of the index. Because path is the primary key, "unique
-- on (vault_id, path, content_hash)" holds as a DERIVED property of "one row per note": a path can
-- only ever have the one content_hash its single row carries, so upserting on a hash change is a
-- REPLACE, not an insert-and-accumulate. This deliberately trades summary history for the same
-- current-state shape `chunks`/`notes` already use, and for a resume-on-content_hash re-summarize
-- check that is a single point lookup rather than a most-recent-row query.
--
-- embedding/embedding_model are nullable: a summary can be written and later fail to embed (gateway
-- reachable, embed provider not), and the row should still record the summary text and skip
-- re-summarizing on the next pass rather than being silently dropped. The retrieval candidate
-- stream (search/note-summaries.ts) only surfaces rows that DO carry an embedding — an
-- unembedded summary is invisible to semantic retrieval until a later pass fills it in.
CREATE TABLE note_summaries (
  vault_id        TEXT NOT NULL,
  path            TEXT NOT NULL,
  content_hash    TEXT NOT NULL,  -- mirrors notes.content_hash (THE-563 lineage: vault-scoped)
  summary         TEXT NOT NULL,
  model           TEXT NOT NULL,  -- gateway extract-role model that produced this summary
  embedding       BLOB,
  embedding_model TEXT,           -- embeddings provider.id, mirrors chunk_embeddings.model
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (vault_id, path)
);
CREATE INDEX idx_note_summaries_hash ON note_summaries(vault_id, content_hash);
