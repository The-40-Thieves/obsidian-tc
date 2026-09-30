-- 20260930_902_auth_tokens.sql
-- auth.db chain (NOT cache.db). Registry of issued bearer tokens and of revoked `jti`s, so a token
-- can be revoked before it expires. Written by `token mint` and `auth revoke`; read on EVERY
-- authenticated request by the verifier (a primary key lookup) and by `auth list`.
--
-- Two kinds of row. An ISSUED row is written by `token mint`: jti, signing `kid`, subject, a short
-- summary of the scopes, and the timestamps (epoch milliseconds); no token string is stored. A
-- TOMBSTONE is written by `auth revoke <jti>` for a jti this registry never issued (a token minted
-- before the registry existed, or by an external issuer behind a JWKS): only jti, revoked_at and
-- revoked_reason are known, so kid, sub, issued_at and expires_at are NULL. Either kind is revoked
-- when `revoked_at IS NOT NULL`. A row is never deleted when the token expires; it stays as the
-- forensic record `auth list --all` reads.
--
-- A token with NO jti cannot be revoked individually; only rotating its signing key kills it, and
-- `auth.requireJti` rejects such tokens outright. The verifier only consults this table after the
-- signature has checked out, so an unauthenticated caller cannot use it to probe which jtis exist.
CREATE TABLE IF NOT EXISTS auth_tokens (
  jti            TEXT PRIMARY KEY,
  kid            TEXT,
  sub            TEXT,
  scopes_summary TEXT NOT NULL DEFAULT '',
  issued_at      INTEGER,
  expires_at     INTEGER,
  revoked_at     INTEGER,
  revoked_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires ON auth_tokens (expires_at);
