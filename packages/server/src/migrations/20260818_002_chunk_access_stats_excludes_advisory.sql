-- 20260818_002_chunk_access_stats_excludes_advisory.sql
-- THE-634 (adversarial review, cross-vendor fix-first): the chunk_access_stats VIEW (recreated by
-- 20260806_001) has no surface_type filter, so a PUSHED advisory row (surface_type = 'advisory',
-- inserted by runtime/advisory-sweep.ts so record_retrieval_feedback has something to stamp)
-- silently bumps access_count and last_accessed_at exactly like a genuine retrieval. Two real
-- consequences, both confirmed: note-quality.ts's stale_access flag reads last_accessed_at from
-- this view, so an advisory push (never asked for, never read) can clear a note's "nobody has
-- looked at this in a while" signal; metrics.ts's knowledge-health scorecard reads access_count
-- from the same view, so the same push inflates the reported retrieval volume. This is the same
-- correctness class activation.ts's two chunk_retrievals SELECTs were fixed for in this ticket's
-- first pass, one layer up: a note the system PUSHED must not read as a note someone RETRIEVED.
--
-- FIX AT THE SOURCE, not at each of the (currently two, likely more over time) readers of this
-- view: the view itself excludes surface_type = 'advisory' rows from its aggregation. Every other
-- reader (note-quality.ts, metrics.ts, contribution.ts's own future use of the view if any) is
-- corrected by construction rather than needing its own filter.
--
-- Views are stateless — dropping and recreating one is an ordinary append-only migration, not a
-- data migration. SQLite has no CREATE OR REPLACE VIEW, so DROP + CREATE is the only form.
--
-- Predicate matches the exact column semantics, not just the advisory case: surface_type is
-- nullable (no NOT NULL, no DEFAULT — 20260626_001_experiential_init.sql), and every existing
-- production writer (experiential/log.ts's createRetrievalLogger) always supplies a real surface
-- name, never NULL, never 'advisory' — so `surface_type IS NULL OR surface_type <> 'advisory'`
-- changes nothing for any row that predates this migration; it only starts excluding what
-- runtime/advisory-sweep.ts writes going forward. Kept NULL-permissive rather than tightened to
-- `surface_type <> 'advisory'` alone because a NULL surface_type is a legitimate historical value
-- (pre-THE-230 rows, or a hand-built test fixture that omits the column), and `<>` against NULL in
-- SQL is UNKNOWN, not TRUE — a naive predicate would silently drop those rows from the count too.
DROP VIEW chunk_access_stats;

CREATE VIEW chunk_access_stats AS
SELECT
  chunk_id,
  COUNT(*)                                                       AS access_count,
  MAX(retrieved_at)                                              AS last_accessed_at,
  SUM(CASE WHEN cited_in_response = 1 THEN 1 ELSE 0 END)         AS citations,
  SUM(CASE WHEN cited_in_response IS NOT NULL THEN 1 ELSE 0 END) AS observed
FROM chunk_retrievals
WHERE surface_type IS NULL OR surface_type <> 'advisory'
GROUP BY chunk_id;
