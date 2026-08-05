-- THE-717 (revised scope item 2): a DURABLE run log for citation-inference passes, so "the pass
-- has never been invoked" and "the pass ran and stamped nothing" stop being the same observation.
--
-- Today they are indistinguishable, and that is not a hypothetical. `citation.ts` keeps no run
-- ledger, and its kill switch deliberately leaves survivor rows NULL "for a clean rerun"
-- (citation.ts, `if (aborted) continue;`). So a NULL `citation_state` means ANY of:
--
--   1. no pass has ever covered this row;
--   2. a pass covered it and the kill switch aborted before stamping;
--   3. a pass covered it and crashed partway.
--
-- Measured 2026-08-04: 105 of 105 live rows are NULL on all three citation columns. That proves
-- no SUCCESSFUL STAMPS. It does not prove zero invocations, and every reader so far — including a
-- tool this repo shipped on 2026-08-04, whose caveat asserted state 1 outright — has read it as
-- if it did. This table is what makes the assertion checkable instead of assumed.
--
-- It lives in experiential.db under the 20260803_002 admission test recorded in
-- migration-manifest.ts: the contents are OBSERVED (a pass happened, at a time, over a scope)
-- rather than AUTHORED, and losing the file costs history rather than vault content. Append-only,
-- one row per pass, on the `gap_reports` (20260729_001) precedent: a run-level observation whose
-- history is itself the useful part, since the question being answered is "when did a pass last
-- cover these rows, and what did it do?"
--
-- NO vault_id, DELIBERATELY. `chunk_retrievals` has no vault column, so `inferCitations` selects
-- its scope by session or by time window and genuinely does not know which vault it is stamping.
-- A vault_id here could only ever be guessed, and a guessed provenance column is precisely the
-- failure this ticket exists to end. This DEPARTS from the 20260803_002_goals precedent ("vault_id
-- from this first migration, deliberately") and the difference is the point: goals are vault-scoped
-- data, a citation pass is not. Add the column if and when the scope becomes vault-aware.
--
-- `finished_at IS NULL` is load-bearing, not laziness. The row is written when the pass STARTS and
-- updated when it returns, so a pass that dies partway leaves a row that says so. Recording only
-- on completion would have folded state 3 back into state 1 and reintroduced the exact ambiguity
-- this table removes.

CREATE TABLE citation_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at     INTEGER NOT NULL,
  -- NULL => the pass never returned. Distinct from a pass that returned having stamped nothing.
  finished_at    INTEGER,
  scope_kind     TEXT NOT NULL,          -- 'session' | 'window'
  session_id     TEXT,                   -- set when scope_kind = 'session'
  window_from    INTEGER,                -- set when scope_kind = 'window'
  window_until   INTEGER,
  -- Outcome counters, all NULL until the pass returns.
  scoped         INTEGER,                -- retrieval rows the scope selected
  stage1_pass    INTEGER,                -- survivors of the cheap ROUGE/cosine filter
  judged         INTEGER,                -- stage-2 judge calls that returned
  parse_failures INTEGER,                -- judge replies that did not parse
  stamped        INTEGER,                -- rows actually written (the number that matters)
  aborted        INTEGER,                -- 1 => kill switch tripped; survivors left NULL
  -- 0 => stage-1-only mode (no gateway judge). A pass with no judge is not a failed pass, but it
  -- is a different claim, and `citation_state` records 'candidate' rather than 'confirmed' for it.
  judge_present  INTEGER NOT NULL
);

-- The read pattern: "did any pass cover these retrievals?" — asked by explain_answer over a
-- window, and by the CLI over a session.
CREATE INDEX idx_citation_runs_window  ON citation_runs(window_from, window_until);
CREATE INDEX idx_citation_runs_session ON citation_runs(session_id);
CREATE INDEX idx_citation_runs_started ON citation_runs(started_at DESC);
