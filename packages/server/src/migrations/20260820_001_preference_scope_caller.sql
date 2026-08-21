-- 20260820_001_preference_scope_caller.sql
-- THE-891 item 6: per-key preference scoping (human vs caller). `PREFERENCE_KEYS` (reflect.ts) now
-- declares a SCOPE per registered key -- "human" (shared by every caller of a vault, correct for a
-- context-free, intent-derived preference) or "caller" (partitioned by principal, because a
-- telemetry-derived preference encodes the OBSERVING AGENT's workload and must not steer a
-- different agent's retrieval). This migration adds the column that partition is stored in.
-- `scope_caller = ''` is the human/shared partition; a non-empty value is one caller's own
-- partition.
--
-- MIGRATION DISPOSITION: PURGE, NOT BACKFILL -- the same precedent 20260803_001 (THE-710) set for
-- this exact pair of tables, itself following 20260724_001 (THE-563): purge when a table is
-- REGENERABLE and its historical attribution is UNRECOVERABLE. `preferred.search_mode` -- the one
-- registered key today, and the only producer that has ever written either table -- never recorded
-- a caller (measured 0 rows on the live deployment 2026-08-03, per 20260803_001's own header; still
-- 0 as of this migration). The deterministic extractor (THE-673) reproduces every one of those rows
-- from RETAINED `agent_episodes`, with correct per-window caller attribution, the next time
-- `obsidian-tc reflect` runs. Backfilling existing rows to `''` would silently misattribute
-- pre-partition history to the shared/human partition -- exactly the invented attribution the
-- 20260724_001/20260803_001 precedent refused twice already.
--
-- NULL-CALLER MAPPING. `agent_episodes.caller` (and `chunk_retrievals.caller`) is NULL for episodes
-- captured over the unauthenticated stdio transport. Those map to `''` here -- the SAME partition
-- human-scoped keys use -- and this is deliberately NOT the invented-attribution case the paragraph
-- above refuses. An unauthenticated local transport is DEFINITIONALLY the single trusted local
-- principal: there is no SECOND null-caller principal whose preferences could bleed into this one's
-- partition, so mapping NULL -> '' is the correct single-principal attribution, not a default
-- standing in for a missing fact. Contrast the NULL-`vault_id` exclusion `extractPreferences`
-- documents at its own query (reflect.ts): a NULL vault really could belong to any configured
-- vault, so that one is excluded outright rather than mapped anywhere.

-- preference_deltas: `id` stays the primary key, so the column is added in place. Existing rows are
-- purged first (see disposition above) so no row is ever left holding `''` as an invented
-- attribution for a caller it never recorded -- the same reasoning 20260803_001 gave for purging
-- ahead of ITS `ALTER ... NOT NULL DEFAULT ''`.
DELETE FROM preference_deltas;
ALTER TABLE preference_deltas ADD COLUMN scope_caller TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_preference_deltas_scope_caller ON preference_deltas(vault_id, scope_caller);

-- preference_profile: `(vault_id, key)` is the whole PRIMARY KEY and SQLite cannot alter one in
-- place, so the table is dropped and recreated with `scope_caller` inserted into the key -- the
-- same rebuild shape 20260803_001 used to add `vault_id` in the first place. Purged (not copied),
-- per the disposition above; every other column definition is unchanged from 20260803_001.
DROP TABLE preference_profile;
CREATE TABLE preference_profile (
  vault_id     TEXT NOT NULL,
  scope_caller TEXT NOT NULL DEFAULT '',  -- '' = human/shared partition; see NULL-caller mapping above
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,
  weight       REAL NOT NULL DEFAULT 1.0,   -- confidence counter: capped [0, 5]; 0 = retracted
  version      INTEGER NOT NULL,            -- monotonic batch version of the last touching delta
  updated_at   INTEGER NOT NULL,            -- per-vault, not global: see applyPreferenceDeltas
  provenance   TEXT,                        -- evidence gist from the extracting pass
  PRIMARY KEY (vault_id, scope_caller, key)
);
