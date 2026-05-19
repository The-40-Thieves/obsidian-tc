-- 20260519_001_initial.sql
-- obsidian-tc V1.0 initial schema migration.
--
-- This migration creates all per-vault tables and indexes from a blank database.
-- The migration runner sets the following PRAGMAs per-connection (not in the
-- migration itself) before applying this file:
--
--   PRAGMA foreign_keys = ON;
--   PRAGMA journal_mode = WAL;
--
-- Folds in the G2.4 B.2 schema delta on idempotency_keys (started_at +
-- completed_at + nullable result/result_size for in-flight detection), since
-- this initial migration has not yet been applied. See docs/G2.3-storage.md
-- and docs/G2.4-security.md for the rationale.
--
-- The vec_chunks sqlite-vec virtual table is NOT created here because its
-- embedding dimensions are runtime-bound per vault. The first embedding
-- generation per vault creates vec_chunks and records itself as
-- 20260519_002_vec_chunks_<DIMS> in schema_migrations.

-- ----------------------------------------------------------------------------
-- Migrations tracking
-- ----------------------------------------------------------------------------

CREATE TABLE schema_migrations (
  version             TEXT PRIMARY KEY,
  applied_at          INTEGER NOT NULL,
  obsidian_tc_version TEXT NOT NULL,
  duration_ms         INTEGER NOT NULL,
  checksum            TEXT NOT NULL
);

-- ----------------------------------------------------------------------------
-- Chunks
-- ----------------------------------------------------------------------------

CREATE TABLE chunks (
  id                TEXT PRIMARY KEY,
  vault_id          TEXT NOT NULL,
  path              TEXT NOT NULL,
  chunk_index       TEXT NOT NULL,
  headings          TEXT NOT NULL,
  content           TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  token_count       INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  cluster_id        INTEGER,
  decay_score       REAL,
  activation_count  INTEGER DEFAULT 0,
  last_accessed_at  INTEGER
);

CREATE INDEX idx_chunks_vault_path ON chunks(vault_id, path);
CREATE INDEX idx_chunks_hash       ON chunks(content_hash);
CREATE INDEX idx_chunks_cluster    ON chunks(cluster_id) WHERE cluster_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Chunk embeddings
-- ----------------------------------------------------------------------------

CREATE TABLE chunk_embeddings (
  chunk_id      TEXT NOT NULL,
  model         TEXT NOT NULL,
  dimensions    INTEGER NOT NULL,
  embedding     BLOB NOT NULL,
  is_active     INTEGER NOT NULL DEFAULT 1,
  generated_at  INTEGER NOT NULL,
  PRIMARY KEY (chunk_id, model),
  FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
);

CREATE INDEX idx_chunk_embeddings_active ON chunk_embeddings(chunk_id) WHERE is_active = 1;
CREATE INDEX idx_chunk_embeddings_model  ON chunk_embeddings(model);

-- ----------------------------------------------------------------------------
-- Workspace sessions
-- ----------------------------------------------------------------------------

CREATE TABLE workspace_sessions (
  id            TEXT PRIMARY KEY,
  vault_id      TEXT NOT NULL,
  caller        TEXT,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  trace_path    TEXT NOT NULL,
  metadata_json TEXT
);

CREATE INDEX idx_workspace_sessions_vault   ON workspace_sessions(vault_id, started_at DESC);
CREATE INDEX idx_workspace_sessions_unended ON workspace_sessions(ended_at) WHERE ended_at IS NULL;

-- ----------------------------------------------------------------------------
-- Capture queue
-- ----------------------------------------------------------------------------

CREATE TABLE capture_queue (
  id                TEXT PRIMARY KEY,
  vault_id          TEXT NOT NULL,
  title             TEXT,
  content           TEXT NOT NULL,
  tags              TEXT,
  source            TEXT,
  target_path_hint  TEXT,
  captured_at       INTEGER NOT NULL,
  committed_at      INTEGER,
  committed_path    TEXT
);

CREATE INDEX idx_capture_uncommitted ON capture_queue(vault_id, captured_at DESC)
  WHERE committed_at IS NULL;

-- ----------------------------------------------------------------------------
-- Memory entities (parents before children for FK satisfaction)
-- ----------------------------------------------------------------------------

CREATE TABLE memory_entities (
  id                TEXT PRIMARY KEY,
  vault_id          TEXT NOT NULL,
  entity_type       TEXT NOT NULL,
  name              TEXT NOT NULL,
  observations      TEXT NOT NULL,
  materialize       INTEGER NOT NULL DEFAULT 1,
  vault_path        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  decay_score       REAL,
  activation_count  INTEGER DEFAULT 0,
  last_accessed_at  INTEGER
);

CREATE INDEX idx_memory_entities_vault_type ON memory_entities(vault_id, entity_type);
CREATE INDEX idx_memory_entities_name       ON memory_entities(vault_id, name);

CREATE TABLE memory_relations (
  source_id      TEXT NOT NULL,
  target_id      TEXT NOT NULL,
  relation_type  TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (source_id, target_id, relation_type),
  FOREIGN KEY (source_id) REFERENCES memory_entities(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES memory_entities(id) ON DELETE CASCADE
);

CREATE INDEX idx_memory_relations_target ON memory_relations(target_id);

-- ----------------------------------------------------------------------------
-- Idempotency keys
-- ----------------------------------------------------------------------------
-- Row lifecycle:
--   1. INSERT on call start: started_at=now, completed_at=NULL,
--      result=NULL, result_size=NULL, expires_at=now+ttl.
--   2. On successful completion: UPDATE result, result_size, completed_at.
--   3. Concurrent INSERT for same (vault_id, key) where completed_at IS NULL
--      raises idempotency_in_flight.
--   4. Sweep reaps rows where started_at+60000 < now AND completed_at IS NULL.
-- ----------------------------------------------------------------------------

CREATE TABLE idempotency_keys (
  vault_id      TEXT NOT NULL,
  key           TEXT NOT NULL,
  tool_name     TEXT NOT NULL,
  args_hash     TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  result        BLOB,
  result_size   INTEGER,
  expires_at    INTEGER NOT NULL,
  PRIMARY KEY (vault_id, key)
);

CREATE INDEX idx_idempotency_expires   ON idempotency_keys(expires_at);
CREATE INDEX idx_idempotency_in_flight ON idempotency_keys(started_at) WHERE completed_at IS NULL;

-- ----------------------------------------------------------------------------
-- Elicit tokens
-- ----------------------------------------------------------------------------

CREATE TABLE elicit_tokens (
  token                 TEXT PRIMARY KEY,
  vault_id              TEXT NOT NULL,
  tool_name             TEXT NOT NULL,
  args_hash             TEXT NOT NULL,
  proposed_change_json  TEXT,
  caller                TEXT,
  created_at            INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL,
  consumed_at           INTEGER
);

CREATE INDEX idx_elicit_tokens_expires ON elicit_tokens(expires_at);

-- ----------------------------------------------------------------------------
-- Event log
-- ----------------------------------------------------------------------------

CREATE TABLE event_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  vault_id     TEXT,
  tool_name    TEXT,
  caller       TEXT,
  duration_ms  INTEGER,
  result_size  INTEGER,
  status       TEXT NOT NULL,
  error_code   TEXT,
  args_hash    TEXT,
  event_type   TEXT
);

CREATE INDEX idx_event_log_ts      ON event_log(ts);
CREATE INDEX idx_event_log_tool_ts ON event_log(tool_name, ts);

-- ----------------------------------------------------------------------------
-- Self-record this migration. The runner overrides duration_ms and checksum
-- after execution with the measured values from this run.
-- ----------------------------------------------------------------------------

INSERT INTO schema_migrations (version, applied_at, obsidian_tc_version, duration_ms, checksum)
VALUES ('20260519_001_initial', strftime('%s','now')*1000, '0.1.0', 0, 'sha256-placeholder');
