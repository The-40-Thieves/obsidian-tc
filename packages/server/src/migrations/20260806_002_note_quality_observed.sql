-- 20260806_002_note_quality_observed.sql
-- THE-718: note_quality follows chunk_access_stats off the outcome axis (20260806_001).
--
-- SPLIT from 20260806_001 deliberately, and not for tidiness. The two touch different tables, and
-- bundling them made the pair inapplicable to any chain that has chunk_retrievals but not yet
-- note_quality — which is most of the chain, since note_quality arrives 14 migrations later
-- (20260725_002). derive-metrics.test.ts builds exactly that prefix to exercise the view, and a
-- combined migration could not be added to it without also dragging in a table it does not use.
--
-- outcome_balance existed only to carry the view's outcome aggregate into the score. With no
-- source it could only ever be its DEFAULT 0, and a stored 0 is indistinguishable from a measured
-- 0 -- exactly the confusion this whole change is about. observed_retrievals replaces it with the
-- denominator scoring actually needs: how many of a note's retrievals the citation pass returned a
-- verdict for. See scoreNote() in experiential/note-quality.ts, and SCORE_VERSION = 2 -- existing
-- rows keep version 1 and stay honest rather than being silently reinterpreted under the new one.
ALTER TABLE note_quality DROP COLUMN outcome_balance;
ALTER TABLE note_quality ADD COLUMN observed_retrievals INTEGER NOT NULL DEFAULT 0;
