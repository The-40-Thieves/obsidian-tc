-- 20260519_001_initial.sql
-- Initial schema migration. V1.0 baseline.
--
-- Creates all tables, indexes, and the schema_migrations log itself.
-- Cascades are FK-driven via ON DELETE CASCADE (no triggers required).
--
-- PRAGMAs are NOT set here. The migration runner sets them per-connection
-- before this file executes:
--   PRAGMA foreign_keys = ON;
--   PRAGMA journal_mode = WAL;
--
-- The vec_chunks virtual table is NOT created here. Its dimension is
-- runtime-bound to the per-vault embeddings.provider config; it is created
-- on first embedding generation per vault as a separate migration
-- (20260519_002_vec_chunks_$DIMS).
--
-- The final INSERT into schema_migrations uses placeholder values for
-- duration_ms and checksum; the migration runner overrides them after
-- successful execution.

-- ============================================================================
-- Migrations tracking (created first so this migration can record itself)
-- ============================================================================

CREATE TABLE schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  obsidian_tc_version TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  checksum TEXT NOT NULL
);

-- ============================================================================
-- Chunks
-- ============================================================================

CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  path TEXT NOT NULL,
  chunk_index TEXT NOT NULL,
  headings TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  cluster_id INTEGER,
  decay_score REAL,
  activation_count INTEGER DEFAULT 0,
  last_accessed_at INTEGER
);

CREATE INDEX idx_chunks_vault_path ON chunks(vault_id, path);
CREATE INDEX idx_chunks_hash ON chunks(content_hash);
CREATE INDEX idx_chunks_cluster ON chunks(cluster_id) WHERE cluster_id IS NOT NULL;

-- ============================================================================
-- Chunk embeddings (depends on chunks)
-- ============================================================================

CREATE TABLE chunk_embeddings (
  chunk_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  generated_at INTEGER NOT NULL,
  PRIMARY KEY (chunk_id, model),
  FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
);

CREATE INDEX idx_chunk_embeddings_active
  ON chunk_embeddings(chunk_id) WHERE is_active = 1;
CREATE INDEX idx_chunk_embeddings_model ON chunk_embeddings(model);

-- ============================================================================
-- Workspace sessions
-- ============================================================================

CREATE TABLE workspace_sessions (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  caller TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  trace_path TEXT NOT NULL,
  metadata_json TEXT
);

CREATE INDEX idx_workspace_sessions_vault
  ON workspace_sessions(vault_id, started_at DESC);
CREATE INDEX idx_workspace_sessions_unended
  ON workspace_sessions(ended_at) WHERE ended_at IS NULL;

-- ============================================================================
-- Capture queue
-- ============================================================================

CREATE TABLE capture_queue (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  tags TEXT,
  source TEXT,
  target_path_hint TEXT,
  captured_at INTEGER NOT NULL,
  committed_at INTEGER,
  committed_path TEXT
);

CREATE INDEX idx_capture_uncommitted
  ON capture_queue(vault_id, captured_at DESC) WHERE committed_at IS NULL;

-- ============================================================================
-- Memory entities + relations
-- ============================================================================

CREATE TABLE memory_entities (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  name TEXT NOT NULL,
  observations TEXT NOT NULL,
  materialize INTEGER NOT NULL DEFAULT 1,
  vault_path TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  decay_score REAL,
  activation_count INTEGER DEFAULT 0,
  last_accessed_at INTEGER
);

CREATE INDEX idx_memory_entities_vault_type
  ON memory_entities(vault_id, entity_type);
CREATE INDEX idx_memory_entities_name
  ON memory_entities(vault_id, name);

CREATE TABLE memory_relations (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (source_id, target_id, relation_type),
  FOREIGN KEY (source_id) REFERENCES memory_entities(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES memory_entities(id) ON DELETE CASCADE
);

CREATE INDEX idx_memory_relations_target ON memory_relations(target_id);

-- ============================================================================
-- Idempotency keys
-- ============================================================================

CREATE TABLE idempotency_keys (
  vault_id TEXT NOT NULL,
  key TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  result BLOB NOT NULL,
  result_size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (vault_id, key)
);

CREATE INDEX idx_idempotency_expires ON idempotency_keys(expires_at);

-- ============================================================================
-- Elicit tokens
-- ============================================================================

CREATE TABLE elicit_tokens (
  token TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  proposed_change_json TEXT,
  caller TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX idx_elicit_tokens_expires ON elicit_tokens(expires_at);

-- ============================================================================
-- Event log
-- ============================================================================

CREATE TABLE event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  vault_id TEXT,
  tool_name TEXT,
  caller TEXT,
  duration_ms INTEGER,
  result_size INTEGER,
  status TEXT NOT NULL,
  error_code TEXT,
  args_hash TEXT,
  event_type TEXT
);

CREATE INDEX idx_event_log_ts ON event_log(ts);
CREATE INDEX idx_event_log_tool_ts ON event_log(tool_name, ts);

-- ============================================================================
-- Record this migration. Runner overrides duration_ms and checksum.
-- ============================================================================

INSERT INTO schema_migrations (version, applied_at, obsidian_tc_version, duration_ms, checksum)
VALUES ('20260519_001_initial', strftime('%s','now')*1000, '0.1.0', 0, 'placeholder-overridden-by-runner');
