-- 20260626_002_plane.sql
-- THE-233 W-WORKERS: sleep-time consolidation plane state tables. Committed here but NOT yet
-- wired into the cli.ts migrate chain — that registration lands in the integration slice
-- (Batch 4), alongside W-SCHEMA's vault_edges/experiential migrations. The plane jobs operate
-- on these tables; the unit tests provision them directly.
--
-- PRAGMAs (foreign_keys, journal_mode = WAL) are set per-connection by the runtime.
-- TRIPWIRE: lifecycle/state tables only. No claim atoms, authoritative_claims, derives_from,
-- or 4-timestamp bi-temporal columns (detected_at/resolved_at is the existing KMS 2-timestamp
-- flag lifecycle, not the engine-build substrate).

-- Contradiction flags (contradiction job; was KMS contradictions table). Flag-only lifecycle.
CREATE TABLE contradictions (
  id                   TEXT PRIMARY KEY,
  source_chunk_id      TEXT NOT NULL,
  source_path          TEXT NOT NULL,
  conflict_chunk_id    TEXT NOT NULL,
  conflict_path        TEXT NOT NULL,
  source_content_sha   TEXT NOT NULL,
  conflict_content_sha TEXT NOT NULL,
  cosine_similarity    REAL,
  judge_verdict        TEXT NOT NULL,        -- 'contradiction' | 'tension'
  judge_rationale      TEXT,
  judge_model          TEXT,                 -- resolved gateway model (attestation)
  status               TEXT NOT NULL DEFAULT 'open',
  detected_at          INTEGER NOT NULL,
  resolved_at          INTEGER
);

-- Dedup a pair regardless of which side was the new chunk (mirrors KMS unique constraint).
CREATE UNIQUE INDEX idx_contradictions_pair ON contradictions(source_content_sha, conflict_content_sha);
CREATE INDEX idx_contradictions_status ON contradictions(status, detected_at DESC);

-- Weekly synthesis records (synthesis job; was KMS syntheses table). One row per ISO week.
CREATE TABLE syntheses (
  iso_year      INTEGER NOT NULL,
  iso_week      INTEGER NOT NULL,
  generated_at  INTEGER NOT NULL,
  cluster_count INTEGER NOT NULL,
  pattern_count INTEGER NOT NULL,
  clusters      TEXT NOT NULL,               -- JSON
  patterns      TEXT NOT NULL,               -- JSON
  judge_model   TEXT,
  PRIMARY KEY (iso_year, iso_week)
);

-- Health audit reports (audit job; was KMS audit_reports/audit_flags collapsed).
CREATE TABLE audit_reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  report_type TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  has_issues  INTEGER NOT NULL,
  summary     TEXT,
  report      TEXT NOT NULL                  -- JSON
);

CREATE INDEX idx_audit_reports_created ON audit_reports(created_at DESC);

-- Plane run log (observability for the local job runner).
CREATE TABLE job_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job         TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  ok          INTEGER NOT NULL,
  detail      TEXT                           -- JSON
);

CREATE INDEX idx_job_runs_job ON job_runs(job, started_at DESC);
