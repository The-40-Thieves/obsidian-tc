-- 20260712_002_access_views.sql
-- THE-44 (local re-scope, 2026-07-11 flywheel decision): derive-don't-mutate. The original
-- ticket added last_accessed_at / access_count columns to the chunk store; the serve-path
-- retrieval log (THE-230) already carries every access event, so the instrumentation is a
-- VIEW over chunk_retrievals — no writer mutates the authored store, and the numbers can
-- never drift from the log they derive from. linked_issue_id became the `linear:` frontmatter
-- convention on notes (notes.frontmatter is queryable JSON), not a column.
CREATE VIEW chunk_access_stats AS
SELECT
  chunk_id,
  COUNT(*)                                                   AS access_count,
  MAX(retrieved_at)                                          AS last_accessed_at,
  SUM(CASE WHEN cited_in_response = 1 THEN 1 ELSE 0 END)     AS citations,
  SUM(CASE WHEN outcome = 1 THEN 1 WHEN outcome = -1 THEN -1 ELSE 0 END) AS outcome_balance
FROM chunk_retrievals
GROUP BY chunk_id;
