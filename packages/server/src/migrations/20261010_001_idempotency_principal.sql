-- 20261010_001_idempotency_principal.sql
-- An idempotency claim was keyed on (vault_id, key) alone, and a replay compared the TOOL and the
-- ARGUMENT HASH but never the caller. So a second principal who reused a first principal's key with
-- identical arguments was handed the first one's cached result: for start_session that is Alice's
-- session_id and trace_path, with `idempotent_replay: true`. This is a cross-principal read of
-- another caller's output, not only a null-caller problem (Alice and Bob can both be identified).
--
-- `principal` joins the primary key, so each caller has its own namespace: Bob's claim on a key
-- Alice holds simply does not collide with it and runs fresh. The value is the server-OBSERVED
-- caller (`ctx.caller`), never anything the caller declares. Dispatch refuses a keyed call from a
-- caller with no identity (a token without `sub`), so '' is never a live principal: it exists only
-- as the column default and for the rows this migration leaves behind (it leaves none, below).
--
-- MIGRATION DISPOSITION: PURGE, NOT COPY -- the precedent 20260820_001 / 20260803_001 / 20260724_001
-- set for a table whose rows carry no recoverable attribution. A row written before this migration
-- recorded the tool and the argument hash but not who made the call, so it cannot be assigned to
-- anyone: copying it as principal '' would park it where nobody can ever read it (until its
-- expires_at), and copying it under some caller would invent an owner and re-open exactly the leak
-- this closes. Dropping it has one visible cost: a keyed call retried within idempotencyTtlSeconds
-- (default 24h) of the upgrade runs again instead of replaying. Keys are per-operation retry
-- tokens, not durable state, and the table is already reaped by expires_at.
--
-- SQLite cannot alter a PRIMARY KEY in place, so the table is dropped and recreated. Every other
-- column is unchanged from 20260519_001 + 20260724_002 (`state`), and both indexes come back.

DROP TABLE idempotency_keys;

CREATE TABLE idempotency_keys (
  vault_id      TEXT NOT NULL,
  principal     TEXT NOT NULL DEFAULT '',   -- ctx.caller; '' is never a live principal (see above)
  key           TEXT NOT NULL,
  tool_name     TEXT NOT NULL,
  args_hash     TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  result        BLOB,
  result_size   INTEGER,
  expires_at    INTEGER NOT NULL,
  state         TEXT NOT NULL DEFAULT 'in_flight',
  PRIMARY KEY (vault_id, principal, key)
);

CREATE INDEX idx_idempotency_expires   ON idempotency_keys(expires_at);
CREATE INDEX idx_idempotency_in_flight ON idempotency_keys(started_at) WHERE completed_at IS NULL;
