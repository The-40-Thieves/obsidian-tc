-- 20261008_952_refresh_hardening.sql
-- oauth.db chain (NOT cache.db, NOT auth.db). Three additions the refresh-token slice needs after review:
--
--  * refresh_tokens.secret_gen: a non-secret fingerprint of the server secret that minted the row
--    (HMAC of the secret under a fixed label, truncated). A refresh token is honoured only while the
--    secret that minted it is still the server's: replacing the secret retires every family at once
--    instead of letting each current token start a new chain under the new one. NULL (rows written
--    before this column existed) never matches, so such a family is refused on its next use and the
--    client signs in again once.
--  * refresh_tokens.replay: the response that CREATED this row, access token included, sealed with a
--    key derived from the server secret and bound to the parent's hash. A client that lost the response
--    and retries the parent inside the one-step window is handed the same response again instead of a
--    new access token each time. NULL once the row has been used (the window is closed) and for the
--    first token of a family.
--  * revocation_outbox: the access-token jtis a family or grant revocation owes the registry (auth.db),
--    written in the SAME transaction as the revocation and deleted only after the registry has
--    recorded each one, so a registry that is busy or full, or a crash between the two databases,
--    leaves the debt on disk to be paid later instead of live tokens behind a committed revocation.
ALTER TABLE refresh_tokens ADD COLUMN secret_gen TEXT;
ALTER TABLE refresh_tokens ADD COLUMN replay TEXT;

CREATE TABLE IF NOT EXISTS revocation_outbox (
  jti        TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
