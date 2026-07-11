-- 20260711_001_experiential_outcome.sql
-- THE-230: the outcome axis on chunk_retrievals — "did acting on this retrieval lead to a
-- good outcome" (-1 | 0 | +1, nullable), DISTINCT from `feedback` (relevance: "was this the
-- right chunk"). A chunk can be perfectly relevant and still lead down a dead end; Brain's
-- dead-end-source avoidance needs the second axis. Stamped by downstream writers (THE-170
-- citation gate, session-close outcome pass); the ACT-R recompute folds it into the event
-- weight the same bounded way it folds feedback.
ALTER TABLE chunk_retrievals ADD COLUMN outcome INTEGER;
