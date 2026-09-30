-- 20260930_001_elicit_state_fingerprint.sql
-- A HITL confirmation approves a specific state of the target, not just a tool + args_hash. This
-- records that state so redemption can refuse a confirmation whose target changed since the request
-- was raised (error code `replay_drift`, elicit-drift.ts).
--
--   elicit_requests   one row per (vault, args_hash, caller): the fingerprint of the call's target
--                     paths at the moment `elicit_required` was raised. Upserted on every raise, so
--                     the row always holds the newest request. It is what `issueElicitToken` (and
--                     therefore the `obsidian-tc elicit` CLI, which only knows the args_hash) binds
--                     a token to. Pruned opportunistically on write; a token's own copy below
--                     outlives the row.
--   elicit_tokens.state_fp  the fingerprint copied onto the token when it was minted. NULL means the
--                     token was minted with no raised request behind it (or the tool declares no
--                     target paths): nothing to compare, so it redeems on args_hash alone, exactly
--                     as before this migration. Every row written before it reads as NULL.
ALTER TABLE elicit_tokens ADD COLUMN state_fp TEXT;

CREATE TABLE elicit_requests (
  vault_id   TEXT    NOT NULL,
  args_hash  TEXT    NOT NULL,
  caller     TEXT    NOT NULL DEFAULT '',
  state_fp   TEXT    NOT NULL,
  raised_at  INTEGER NOT NULL,
  PRIMARY KEY (vault_id, args_hash, caller)
);

CREATE INDEX idx_elicit_requests_raised ON elicit_requests(raised_at);
