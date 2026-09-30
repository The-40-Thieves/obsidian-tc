-- 20260930_002_auth_tokens.sql
-- Registry of issued bearer tokens, keyed by the `jti` claim, so a token can be revoked before it
-- expires. Written by `token mint`; read on EVERY authenticated request by the verifier (a primary
-- key lookup) and by `auth list` / `auth revoke`.
--
-- No token string is stored, only its identity: jti, the signing `kid`, the subject, a short
-- summary of the scopes, and the timestamps. Times are epoch milliseconds. A row is never deleted
-- when the token expires; it stays as the forensic record `auth list --all` reads.
--
-- Revocation is `revoked_at IS NOT NULL`. The verifier only consults this table after the
-- signature has checked out, so an unauthenticated caller cannot use it to probe which jtis exist.
CREATE TABLE IF NOT EXISTS auth_tokens (
  jti            TEXT PRIMARY KEY,
  kid            TEXT NOT NULL,
  sub            TEXT,
  scopes_summary TEXT NOT NULL DEFAULT '',
  issued_at      INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  revoked_at     INTEGER,
  revoked_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires ON auth_tokens (expires_at);
