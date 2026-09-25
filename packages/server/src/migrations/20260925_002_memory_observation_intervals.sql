-- 20260925_002_memory_observation_intervals.sql (20260925_001 is telemetry_state, unrelated — this
-- ticket's original slot collided with it once rebased onto main, bumped to _002)
-- THE-1130: validity intervals on memory observations. `memory_entities.observations` carries the
-- TEXT (a supersession or retirement only ever sets a `valid_to` on the interval row below, never
-- touches the text — see memory/entities.ts's own header on this table for the corrected wording
-- of that invariant); this table is the STRUCTURE layered on top, one row per observation line,
-- recording when it was true and whether something replaced it.
--
-- Design (see the ticket's design-decision record for the alternative considered and rejected —
-- migrating observations to their own table outright): keeping the text blob as-is and adding one
-- narrow interval table is a single-table, single-concern migration (the
-- migration-bundling-breaks-prefix-chains lesson: one table per migration, even when it serves one
-- ticket).
--
-- Row identity is BY POSITION, not by hash: every write path that appends text to the blob inserts
-- exactly one interval row in the SAME transaction, so the Nth line in
-- `parseObservations(observations)` is always the Nth row of this table for that entity_id, in
-- `rowid` order. `obs_hash` is NOT a lookup key — matching for supersession is by `key` alone (see
-- the ticket's decision record: matching is explicit, never inferred from text). `obs_hash` is
-- informational provenance only: a sha256 (hex) of the trimmed observation text with any `[key] `
-- rendering prefix excluded, recorded so `superseded_by` on the row it replaced can name which
-- exact text superseded it without a second free-text column carrying the same string twice.
--
-- `key`: an optional, explicit, caller-supplied slug (validated by `add_observation`'s own zod
-- schema, not by this table) that opts an observation INTO supersession tracking. An observation
-- added with no key never supersedes and is never superseded automatically — it always just
-- appends, exactly like `add_observation` behaved before this ticket. At most one OPEN
-- (`valid_to IS NULL`) row may exist per (entity_id, key) at a time — enforced with a partial
-- UNIQUE index below, defense in depth alongside the application-level check in `add_observation`,
-- the same posture `memory_entities.status`'s CHECK constraint takes (20260814_001).
--
-- THIS FILE CREATES THE TABLE ONLY. Backfilling one open interval row per pre-existing observation
-- is a JS step (db/backfill-observation-intervals.ts), run as this migration's `postApply` hook
-- (db/migrate.ts, wired in db/provision.ts) rather than in SQL here — adversarial review found a
-- real divergence between SQLite's `trim()` (strips only the ASCII space character by default) and
-- the JS `.trim()` every read path actually uses (memory/entities.ts's `parseObservations`, which
-- also strips tab and CR): a fixture with a tab-only "blank" line and a `\r\n` line ending parsed to
-- 3 facts in JS but produced 4 rows from an earlier SQL-recursive-CTE version of this backfill. The
-- JS step re-parses each entity's text with the SAME `parseObservations` every read path uses,
-- rewrites the column via `serializeObservations` of that exact parse (so the stored bytes can
-- never again disagree with a future re-parse of themselves), and inserts one open, unkeyed
-- interval row per resulting line, in order, with `valid_from` = the owning entity's `created_at`
-- (the observation's own append time is not recorded anywhere pre-migration — the entity's creation
-- instant is the closest available lower bound, and is exact for every observation an entity was
-- created with via `create_entity`'s batch `observations` array, which is how the vast majority of
-- entities got their initial facts).

CREATE TABLE memory_observation_intervals (
  id             INTEGER PRIMARY KEY,
  entity_id      TEXT NOT NULL,
  obs_hash       TEXT NOT NULL,
  key            TEXT,
  valid_from     INTEGER NOT NULL,
  valid_to       INTEGER,
  superseded_by  TEXT,
  created_at     INTEGER NOT NULL,
  FOREIGN KEY (entity_id) REFERENCES memory_entities(id) ON DELETE CASCADE
);

CREATE INDEX idx_memory_observation_intervals_entity
  ON memory_observation_intervals(entity_id, id);

-- At most one open interval per (entity_id, key) — the invariant `add_observation`'s supersede
-- path depends on ("the same entity has an OPEN observation with that key" is well-defined only
-- if there is never more than one). `key IS NOT NULL` in the predicate means unkeyed rows (which
-- never participate in supersession) are exempt, so many open unkeyed observations coexist freely.
CREATE UNIQUE INDEX idx_memory_observation_intervals_open_key
  ON memory_observation_intervals(entity_id, key)
  WHERE valid_to IS NULL AND key IS NOT NULL;
