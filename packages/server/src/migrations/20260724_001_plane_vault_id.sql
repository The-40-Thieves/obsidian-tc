-- 20260724_001_plane_vault_id.sql
-- THE-563: namespace the derived-cognition plane. contradictions + syntheses predate the shared
-- cache.db vault_id isolation that chunks/notes/embeddings carry. Both are REGENERABLE derived
-- caches (contradictions re-flag on the next reindex; syntheses regenerate on the next weekly run)
-- and their historical vault is UNRECOVERABLE (a contradiction may pair chunks from two vaults; a
-- synthesis blended every vault). So we PURGE the unscoped rows rather than backfill a guess -- the
-- same disposition THE-310 (20260703_001) took for vault_edges. Writers repopulate scoped.

-- contradictions: purge, add vault_id, re-scope the pair-dedup index to include it so two vaults may
-- hold the same content-sha pair. NOT NULL DEFAULT '' satisfies the ALTER on the emptied table; no
-- row is ever written with '' (every writer supplies a real vault_id).
DELETE FROM contradictions;
ALTER TABLE contradictions ADD COLUMN vault_id TEXT NOT NULL DEFAULT '';
DROP INDEX IF EXISTS idx_contradictions_pair;
CREATE UNIQUE INDEX idx_contradictions_pair
  ON contradictions(vault_id, source_content_sha, conflict_content_sha);
CREATE INDEX IF NOT EXISTS idx_contradictions_vault ON contradictions(vault_id);

-- syntheses: a composite PK cannot be altered in place. DROP discards the unscoped rows (purge) and
-- the table is recreated with vault_id leading the PK so each vault owns one row per ISO week.
DROP TABLE syntheses;
CREATE TABLE syntheses (
  vault_id      TEXT NOT NULL,
  iso_year      INTEGER NOT NULL,
  iso_week      INTEGER NOT NULL,
  generated_at  INTEGER NOT NULL,
  cluster_count INTEGER NOT NULL,
  pattern_count INTEGER NOT NULL,
  clusters      TEXT NOT NULL,
  patterns      TEXT NOT NULL,
  judge_model   TEXT,
  PRIMARY KEY (vault_id, iso_year, iso_week)
);
