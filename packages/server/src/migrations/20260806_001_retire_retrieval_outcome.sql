-- 20260806_001_retire_retrieval_outcome.sql
-- THE-718 (final): chunk_retrievals.outcome is retired. It never had a coherent estimand.
--
-- `outcome` and `cited_in_response` were introduced as parallel signals on the same row, but they
-- measure DIFFERENT units: citation is a property of (response x chunk) -- did this text use this
-- chunk -- while outcome is a property of (task x chunk) -- did acting on this lead somewhere good.
-- A retrieval row is a response-level event, so the task-level question has no denominator here:
-- one task spans many retrievals, and stamping the axis per row silently attributes a whole task's
-- success to each chunk that happened to be returned. There is no aggregation of that column that
-- answers a question we actually have.
--
-- Measured before removing (live experiential.db, 2026-08-06):
--   chunk_retrievals   108 rows, outcome stamped on 0, feedback stamped on 0
--   agent_episodes     414 rows, outcome stamped on 0
-- The column was also UNREACHABLE until 2026-08-03 (THE-718 / #677 -- NULL was not a valid
-- principal, so no caller could stamp), and 11 retrievals have happened since. So the zero is
-- not evidence of low adoption of a working signal; there has never been a working signal to adopt.
-- Deleting is honest, and `derived.column-liveness` (THE-720) has been reporting it dead by design.
--
-- What is NOT removed: cited_in_response. That column has an AUTOMATIC writer (citation.ts, the
-- THE-170 inference pass), so it is unstamped for an operational reason -- the gateway `judge`
-- role 404s against the retired Modal deployment (THE-717) -- not a modelling one. It is fixable
-- where outcome is not, and it stays.
--
-- The view must be recreated BEFORE the column drops: SQLite refuses ALTER TABLE ... DROP COLUMN
-- while any view references the column, and chunk_access_stats reads it.
DROP VIEW chunk_access_stats;

-- Same derive-don't-mutate contract as 20260712_002, minus the outcome axis, plus the denominator
-- that was missing. `observed` counts retrievals carrying a citation VERDICT (0 or 1), as distinct
-- from `access_count`, which counts retrievals that merely happened. Scoring divided citations by
-- access_count, so an unjudged retrieval read as a negative citation -- see the note_quality
-- change below and scoreNote() in note-quality.ts.
CREATE VIEW chunk_access_stats AS
SELECT
  chunk_id,
  COUNT(*)                                                       AS access_count,
  MAX(retrieved_at)                                              AS last_accessed_at,
  SUM(CASE WHEN cited_in_response = 1 THEN 1 ELSE 0 END)         AS citations,
  SUM(CASE WHEN cited_in_response IS NOT NULL THEN 1 ELSE 0 END) AS observed
FROM chunk_retrievals
GROUP BY chunk_id;

ALTER TABLE chunk_retrievals DROP COLUMN outcome;
