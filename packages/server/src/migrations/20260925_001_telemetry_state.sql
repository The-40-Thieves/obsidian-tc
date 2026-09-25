-- 20260925_001_telemetry_state.sql
-- THE-1125: opt-in, anonymous usage telemetry (off by default, no default endpoint). Holds ONLY
-- the install id (a random UUID, never derived from anything vault- or principal-identifying) and
-- the outcome of the last send attempt, so `doctor`/`server_health`/`telemetry status` can report
-- lastSendAt/lastError across restarts without re-deriving them from log lines.
--
-- Single-row table (id fixed at 1, enforced by CHECK) — the same shape as a settings/kv row would
-- be, but purpose-built rather than a generic key-value table: telemetry_state.installId is the
-- only durable identity this feature owns, and `obsidian-tc telemetry reset-id` deliberately
-- REPLACES this row's installId, not the whole cache.db's identity, so it stays its own table
-- rather than being folded into an existing one that mixes unrelated concerns.
--
-- Belongs in the CACHE chain (db/migration-manifest.ts's CACHE_MIGRATION_FILES), not EXPERIENTIAL:
-- an install id is AUTHORED server-instance state (like vault_generation, activation_state), not
-- observed/derived retrieval telemetry — see migration-manifest.ts's THE-713 admission test.
CREATE TABLE IF NOT EXISTS telemetry_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  install_id    TEXT NOT NULL,
  last_send_at  INTEGER,          -- ms epoch of the last ATTEMPTED send (success or failure).
  last_error    TEXT,             -- message from the last FAILED send; NULL after a success.
  created_at    INTEGER NOT NULL  -- ms epoch this row (or its current install_id) was created.
);
