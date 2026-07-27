-- THE-627: which client software opened this session.
--
-- Sourced from the MCP request's `_meta` key `io.modelcontextprotocol/clientInfo` (see
-- src/mcp/client-info.ts), NOT from the `initialize` handshake — that handshake is removed in MCP
-- 2026-07-28, while `_meta` works under both that spec and the current one.
--
-- Both columns are NULLABLE and stay NULL when the client sends nothing, which is the normal case
-- today: no current client sends this key, and a placeholder like 'unknown' would be
-- indistinguishable from a client that genuinely reports that name.
--
-- Deliberately NOT folded into the existing `metadata_json` column. That column holds
-- CALLER-SUPPLIED session metadata from start_session's `session_metadata` argument; client identity
-- is observed by the server from the transport. Mixing an observation into the caller's own bag
-- would make the two indistinguishable downstream.
--
-- No index: these are read alongside a session row already located by id or by the existing
-- (vault_id, started_at) index, never used as a lookup key.

ALTER TABLE workspace_sessions ADD COLUMN client_name TEXT;
ALTER TABLE workspace_sessions ADD COLUMN client_version TEXT;
