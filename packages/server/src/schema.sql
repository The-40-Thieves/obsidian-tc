-- packages/server/src/schema.sql
-- This file documents the V1.0 schema for obsidian-tc.
-- The authoritative source of truth is packages/server/src/migrations/20260519_001_initial.sql.
-- All schema changes go through migrations; this file is regenerated.
--
-- PRAGMAs are set per-connection by the runtime, not in this file:
--   PRAGMA foreign_keys = ON;
--   PRAGMA journal_mode = WAL;
--
-- One cache DB per vault, at <cache_dir>/cache.db (cache_dir is per-vault). A sibling
-- experiential.db holds the low-trust membrane tier, provisioned on its own migration chain.

-- ============================================================================
-- Migrations tracking
-- ============================================================================

CREATE TABLE schema_migrations (
  version             TEXT PRIMARY KEY,
  applied_at          INTEGER NOT NULL,
  obsidian_tc_version TEXT NOT NULL,
  duration_ms         INTEGER NOT NULL,
  checksum            TEXT NOT NULL                 -- SHA-256 of migration file content
);

-- ============================================================================
-- Chunks (metadata only; embeddings live in chunk_embeddings)
-- ============================================================================

CREATE TABLE chunks (
  id                TEXT PRIMARY KEY,               -- stable chunk ID, e.g. "chk_01h8x..."
  vault_id          TEXT NOT NULL,
  path              TEXT NOT NULL,                  -- vault-relative note path
  chunk_index       TEXT NOT NULL,                  -- "3" or "3.1" for sub-chunked sections
  headings          TEXT NOT NULL,                  -- JSON array of heading breadcrumb
  content           TEXT NOT NULL,
  content_hash      TEXT NOT NULL,                  -- SHA-256 of content for change detection
  token_count       INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  -- V2-reserved (NULL in V1, populated in V2)
  cluster_id        INTEGER,
  decay_score       REAL,
  activation_count  INTEGER DEFAULT 0,
  last_accessed_at  INTEGER
);

CREATE INDEX idx_chunks_vault_path ON chunks(vault_id, path);
CREATE INDEX idx_chunks_hash       ON chunks(content_hash);
CREATE INDEX idx_chunks_cluster    ON chunks(cluster_id) WHERE cluster_id IS NOT NULL;

-- ============================================================================
-- Chunk embeddings (split table, versioned per model)
-- ============================================================================

CREATE TABLE chunk_embeddings (
  chunk_id      TEXT NOT NULL,
  model         TEXT NOT NULL,                       -- provider:model, e.g. "openai:text-embedding-3-small"
  dimensions    INTEGER NOT NULL,
  embedding     BLOB NOT NULL,
  is_active     INTEGER NOT NULL DEFAULT 1,          -- exactly one is_active=1 per chunk_id (app-enforced)
  generated_at  INTEGER NOT NULL,
  PRIMARY KEY (chunk_id, model),
  FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
);

CREATE INDEX idx_chunk_embeddings_active ON chunk_embeddings(chunk_id) WHERE is_active = 1;
CREATE INDEX idx_chunk_embeddings_model  ON chunk_embeddings(model);

-- ============================================================================
-- Vector index (sqlite-vec virtual table)
-- Created at runtime by the migration runner once per vault, since the
-- dimension count is bound to the vault's embeddings.provider config.
-- Not created in 20260519_001_initial.sql for that reason. The first
-- embedding generation per vault runs:
--
--   CREATE VIRTUAL TABLE vec_chunks USING vec0(
--     chunk_id TEXT PRIMARY KEY,
--     embedding float[$DIMS]
--   );
--
-- And records itself as `20260519_002_vec_chunks_$DIMS` in schema_migrations.
-- ============================================================================

-- ============================================================================
-- Workspace sessions + JSONL trace pointers
-- ============================================================================

CREATE TABLE workspace_sessions (
  id            TEXT PRIMARY KEY,                    -- session_id, e.g. "sess_01h8x..."
  vault_id      TEXT NOT NULL,
  caller        TEXT,                                -- jwt sub or "anonymous"
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  trace_path    TEXT NOT NULL,                       -- relative to cache_dir/<vault>/traces/
  metadata_json TEXT                                 -- optional session-start metadata
);

CREATE INDEX idx_workspace_sessions_vault   ON workspace_sessions(vault_id, started_at DESC);
CREATE INDEX idx_workspace_sessions_unended ON workspace_sessions(ended_at) WHERE ended_at IS NULL;

-- ============================================================================
-- Capture queue (inbox pattern)
-- ============================================================================

CREATE TABLE capture_queue (
  id                TEXT PRIMARY KEY,
  vault_id          TEXT NOT NULL,
  title             TEXT,
  content           TEXT NOT NULL,
  tags              TEXT,                            -- comma-separated
  source            TEXT,                            -- which client/agent captured this
  target_path_hint  TEXT,                            -- destination on commit (suggestion, not binding)
  captured_at       INTEGER NOT NULL,
  committed_at      INTEGER,                         -- NULL until committed to vault
  committed_path    TEXT                             -- final destination after commit
);

CREATE INDEX idx_capture_uncommitted ON capture_queue(vault_id, captured_at DESC)
  WHERE committed_at IS NULL;

-- ============================================================================
-- Memory entities + relations (SQLite source of truth, optional .md materialization)
-- ============================================================================

CREATE TABLE memory_entities (
  id                TEXT PRIMARY KEY,                -- "ent_01h8x..."
  vault_id          TEXT NOT NULL,
  entity_type       TEXT NOT NULL,                   -- person | project | decision | concept | place | other
  name              TEXT NOT NULL,
  observations      TEXT NOT NULL,                   -- newline-separated facts
  materialize       INTEGER NOT NULL DEFAULT 1,
  vault_path        TEXT,                            -- materialized .md file path (relative)
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  -- V2-reserved (activation tracking, matches chunks)
  decay_score       REAL,
  activation_count  INTEGER DEFAULT 0,
  last_accessed_at  INTEGER
);

CREATE INDEX idx_memory_entities_vault_type ON memory_entities(vault_id, entity_type);
CREATE INDEX idx_memory_entities_name       ON memory_entities(vault_id, name);
-- Natural key (F4): (vault_id, entity_type, name) is unique — closes the create_entity
-- read-then-insert race. Migration 20260519_002 dedups + adds this on existing DBs.
CREATE UNIQUE INDEX idx_memory_entities_natural_key ON memory_entities(vault_id, entity_type, name);

CREATE TABLE memory_relations (
  source_id      TEXT NOT NULL,
  target_id      TEXT NOT NULL,
  relation_type  TEXT NOT NULL,                      -- arbitrary verb, e.g. "founded", "works_on"
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (source_id, target_id, relation_type),
  FOREIGN KEY (source_id) REFERENCES memory_entities(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES memory_entities(id) ON DELETE CASCADE
);

CREATE INDEX idx_memory_relations_target ON memory_relations(target_id);

-- ============================================================================
-- Idempotency keys
-- ============================================================================
-- G2.4 B.2 schema delta folded in: in-flight detection via started_at +
-- completed_at + nullable result/result_size. started_at also serves as the
-- canonical "this key began processing" timestamp (replaces created_at from
-- the original G2.3 D2 sketch since they're semantically the same in the
-- single-execution-per-key model).
--
-- Row lifecycle:
--   1. INSERT on call start: started_at=now, completed_at=NULL, result=NULL,
--      result_size=NULL, expires_at=now + ttl_seconds*1000.
--   2. On successful completion: UPDATE result=<blob>, result_size=<bytes>,
--      completed_at=now.
--   3. Replay reads existing row if completed_at IS NOT NULL.
--   4. Concurrent INSERT with same (vault_id, key) and completed_at IS NULL
--      raises idempotency_in_flight.
--   5. Sweep reaps rows where started_at + 60000 < now AND
--      completed_at IS NULL (process crashed mid-execution).
-- ============================================================================

CREATE TABLE idempotency_keys (
  vault_id      TEXT NOT NULL,
  key           TEXT NOT NULL,
  tool_name     TEXT NOT NULL,
  args_hash     TEXT NOT NULL,                       -- 16B hex, same derivation as elicit
  started_at    INTEGER NOT NULL,                    -- G2.4 B.2: call start; also serves as created_at
  completed_at  INTEGER,                             -- NULL while in-flight (G2.4 B.2)
  result        BLOB,                                -- NULL while in-flight; canonical JSON of tool output
  result_size   INTEGER,                             -- NULL while in-flight; bytes; G2.4 B.1 governor uses this
  expires_at    INTEGER NOT NULL,                    -- TTL expiry (default now + 86400000ms)
  PRIMARY KEY (vault_id, key)
);

CREATE INDEX idx_idempotency_expires   ON idempotency_keys(expires_at);
CREATE INDEX idx_idempotency_in_flight ON idempotency_keys(started_at) WHERE completed_at IS NULL;

-- ============================================================================
-- Elicit tokens (5min TTL, single-use, audit row)
-- ============================================================================

CREATE TABLE elicit_tokens (
  token                 TEXT PRIMARY KEY,            -- 32-char hex, 16 bytes entropy
  vault_id              TEXT NOT NULL,
  tool_name             TEXT NOT NULL,
  args_hash             TEXT NOT NULL,               -- 16B hex
  proposed_change_json  TEXT,                        -- canonical JSON of what was elicited
  caller                TEXT,
  created_at            INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL,
  consumed_at           INTEGER                      -- NULL until single-use redemption
);

CREATE INDEX idx_elicit_tokens_expires ON elicit_tokens(expires_at);

-- ============================================================================
-- Event log (sampled events, 30-day default retention)
-- ============================================================================

CREATE TABLE event_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  vault_id     TEXT,
  tool_name    TEXT,
  caller       TEXT,
  duration_ms  INTEGER,
  result_size  INTEGER,
  status       TEXT NOT NULL,                        -- "ok" | "error" | "skipped"
  error_code   TEXT,
  args_hash    TEXT,
  event_type   TEXT                                  -- "tool_invocation" | "sweep_run" | "server_started" | ...
);

CREATE INDEX idx_event_log_ts      ON event_log(ts);
CREATE INDEX idx_event_log_tool_ts ON event_log(tool_name, ts);
