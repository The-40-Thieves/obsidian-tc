-- 20260803_001_preference_vault_id.sql
-- THE-710: namespace the preference plane by vault.
--
-- CORRECTION TO THE TICKET, recorded here because a migration is the permanent record. THE-710 says
-- the THE-563/564 derived-plane namespacing "skipped" these tables. It did not. The global scope was
-- DELIBERATE, audited under THE-562 P1.8, and documented in two places: the NAMESPACE comment above
-- applyPreferenceDeltas, and SECURITY.md's "Learned-state namespaces" table ("Global / shared
-- runtime -- One learned preference profile for the runtime"). This migration REVERSES that
-- decision, on one axis only, and SECURITY.md is rewritten in the same change so the two stop
-- disagreeing.
--
-- WHY REVERSE IT. The recorded rationale is "correct for the single-user model", and the residual
-- SECURITY.md deliberately keeps open is a MULTI-PRINCIPAL one -- the `caller` axis. Single-user is
-- not single-VAULT. With two vaults configured (this deployment runs `main` and `agents`), `key` as
-- the entire primary key means a preference learned from one vault's episodes silently overwrites
-- the same key learned from another's, and there is no column to filter on because none exists.
-- That is the THE-310 defect class (vault_edges had no vault_id, so a cross-vault reconcile deleted
-- another vault's edges) one layer up.
--
-- WHAT THIS DELIBERATELY DOES NOT DO. The caller axis stays an accepted residual: preferences remain
-- shared across callers within a vault. Closing that too would make every reader caller-scoped and
-- needs the P1.7 authorization treatment agent_episodes got, which is a larger change than this one.
--
-- PURGE, NOT BACKFILL -- and this contradicts THE-710's stated shape ("backfill to the default
-- vault"). 20260724_001 (THE-563) set the test: purge when a table is REGENERABLE and its historical
-- vault is UNRECOVERABLE. Preferences are both. reflect.ts re-extracts them from agent_episodes,
-- which are retained; and no column ever recorded which vault a preference came from, so backfilling
-- to a default would INVENT an attribution indistinguishable downstream from a measured one. Same
-- disposition THE-310 (20260703_001) and THE-563 (20260724_001) took, for the same reason. On this
-- deployment the purge is free -- both tables measured 0 rows on 2026-08-03 -- which is precisely
-- why the rebuild is being done now rather than after THE-673 determinizes the extractor.

-- preference_deltas: `id` is the primary key and is unaffected, so the column is added in place. The
-- purge above is what makes NOT NULL satisfiable on an ALTER; no row is ever written with '',
-- because applyPreferenceDeltas now takes vaultId as a REQUIRED argument rather than a defaulted one
-- -- a default would silently reintroduce the blending this migration exists to stop.
DELETE FROM preference_deltas;
ALTER TABLE preference_deltas ADD COLUMN vault_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_preference_deltas_vault ON preference_deltas(vault_id);

-- preference_profile: `key` is the whole PRIMARY KEY and SQLite cannot alter one in place, so the
-- table is dropped and recreated with vault_id LEADING the key -- the same shape 20260724_001 used
-- for syntheses. Every other column definition is unchanged from 20260712_001.
DROP TABLE preference_profile;
CREATE TABLE preference_profile (
  vault_id    TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  weight      REAL NOT NULL DEFAULT 1.0,   -- confidence counter: capped [0, 5]; 0 = retracted
  version     INTEGER NOT NULL,            -- monotonic batch version of the last touching delta
  updated_at  INTEGER NOT NULL,            -- per-vault, not global: see applyPreferenceDeltas
  provenance  TEXT,                        -- evidence gist from the extracting pass
  PRIMARY KEY (vault_id, key)
);
