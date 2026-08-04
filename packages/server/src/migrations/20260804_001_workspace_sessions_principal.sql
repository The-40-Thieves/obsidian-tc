-- 20260804_001_workspace_sessions_principal.sql
-- THE-726: record the OBSERVED principal that owns a session, so an active session can be resolved
-- durably instead of from a process-local in-memory map.
--
-- WHY A NEW COLUMN RATHER THAN REUSING `caller`. This table already has one. It holds
-- `input.caller` -- a REQUIRED, caller-supplied free-text string from start_session's input schema.
-- Meanwhile ActiveSessionTracker keys on `ctx.caller`, the server-observed principal from the
-- transport. Those are different values with different trust:
--
--     insertSession(ctx.db, { ..., caller: input.caller })   -- DECLARATION
--     deps.activeSessions?.set(ctx.caller, id, v.id)         -- OBSERVATION
--
-- Making the durable lookup key on the existing column would join an observation against a
-- declaration. Since `caller` is free text and start_session's only gate is the `write:workspace`
-- scope, any authorised client could declare another principal's name and have that principal's
-- subsequent dispatches inherit its session_id. A session id is the correlation key for retrieval
-- history and episodes, so that is a cross-principal read, not a cosmetic mix-up.
--
-- This is the THE-627 precedent applied one field over. That change added client_name/client_version
-- and its comment states the rule directly: server-observed identity is "kept separate from the
-- caller-supplied `session_metadata` above so an observation and a declaration stay
-- distinguishable." `caller` keeps its meaning and its readers; `principal` is the authenticated
-- one, and only `principal` may resolve an active session.
--
-- NULLABLE, and that is not laziness. Every row written before this migration has no recorded
-- observation -- there is no value to backfill that would be true, and inventing one (copying
-- `caller` across) would manufacture exactly the observation/declaration collapse this column
-- exists to prevent. A NULL principal means "not resolvable as an active session", which is the
-- correct and safe reading for a historical row. There are 0 rows on the live store today, so the
-- backfill question is theoretical here and load-bearing for anyone who already has sessions.
--
-- THE INDEX IS PARTIAL, matching idx_workspace_sessions_unended directly above it. The lookup this
-- exists for is always "the one unended session for this principal", so rows with ended_at set are
-- dead weight in the index. Ordering is (principal, started_at DESC) so the most recent open
-- session for a principal is the first row read -- a principal SHOULD only have one, but the schema
-- does not enforce that and the resolver must not depend on it.

ALTER TABLE workspace_sessions ADD COLUMN principal TEXT;

CREATE INDEX idx_workspace_sessions_principal
  ON workspace_sessions(principal, started_at DESC)
  WHERE ended_at IS NULL AND principal IS NOT NULL;
