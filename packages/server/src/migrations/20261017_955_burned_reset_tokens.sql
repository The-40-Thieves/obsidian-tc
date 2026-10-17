-- 20261017_955_burned_reset_tokens.sql
-- oauth.db chain (NOT cache.db, NOT auth.db). The no-shell operator credential reset (design v2
-- section 4.11.5, item 3): one row per reset token that has already reset the password, keyed by the
-- SHA-256 of the token and recorded in the same transaction as the reset (as-passkey-store.ts
-- `resetOperatorCredentials`, `burn`). A restart cannot let a used token reset again, and a newer
-- token leaves every older one burned. Rows are never pruned: a burned token stays burned.
CREATE TABLE IF NOT EXISTS burned_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  used_at    INTEGER NOT NULL
);
