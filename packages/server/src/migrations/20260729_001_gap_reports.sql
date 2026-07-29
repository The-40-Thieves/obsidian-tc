-- THE-644 item 1: persist the gap-detector's GapReport so a pass can be read back later instead of
-- recomputed. Precondition for the THE-611 read-only MCP tool (gap_report), which reads the latest
-- row here rather than re-embedding + re-searching every query on every call.
--
-- It lives in experiential.db, not cache.db, for the same reason note_quality does (20260725_002):
-- it is DERIVED and RESETTABLE, not authored vault content.
--
-- APPEND-ONLY, one row per pass — unlike note_quality's per-note upsert rollup, a gap report is a
-- single run-level observation (a whole calibrated pass over a query set), and history across
-- passes is itself useful ("did this query stop being a gap?"). The read side always wants the
-- LATEST pass for a vault; older rows are kept for that history, not pruned here.
--
-- `items` is the GapReport.items array, JSON-encoded VERBATIM in the order detectGaps produced it
-- (THE-616: input order, not sorted) — the report is diffed run-to-run, so preserving that order on
-- the way into and out of storage matters as much as it does in the in-memory shape.

CREATE TABLE gap_reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_id     TEXT NOT NULL,
  computed_at  INTEGER NOT NULL,
  threshold    REAL NOT NULL,
  min_results  INTEGER NOT NULL,
  total        INTEGER NOT NULL,
  gaps         INTEGER NOT NULL,
  gap_rate     REAL NOT NULL,
  items        TEXT NOT NULL   -- JSON array of GapItem, order-preserving
);

-- The read tool's access pattern: latest pass for a vault.
CREATE INDEX idx_gap_reports_vault_computed ON gap_reports(vault_id, computed_at DESC);
