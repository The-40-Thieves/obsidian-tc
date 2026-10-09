-- 20261009_953_webauthn.sql
-- oauth.db chain (NOT cache.db, NOT auth.db). The operator's passkeys (design v2 section 4.11, slice S10),
-- added BESIDE the password: a lost passkey is recovered with the password or with
-- `auth as reset-credentials`.
--
--  * webauthn_credentials: one row per registered passkey. `credential_id` and `public_key` are
--    base64url (the public key is the COSE key as the authenticator produced it). `sign_count` is the
--    authenticator's counter at its last use: a stored non-zero value that a new assertion does not
--    exceed is a clone signal and the assertion is refused; a constant 0 (synced passkeys) is accepted.
--    `transports` is a JSON array text, `device_type` the library's `singleDevice` or `multiDevice`.
--    The credential is bound to the relying party it was registered for by the authenticator itself
--    (the rpID hash it signs), so a hostname change orphans it: that is what the reset command is for.
--  * webauthn_challenges: the challenges handed out and not yet answered, as a SHA-256 of the challenge.
--    A challenge is single-use (deleted when an answer arrives) and short-lived (swept on expiry). A
--    registration challenge carries the operator it was issued to; a login challenge carries none.
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  credential_id TEXT PRIMARY KEY,
  sub           TEXT NOT NULL REFERENCES users (sub) ON DELETE CASCADE,
  public_key    TEXT NOT NULL,
  sign_count    INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,
  device_type   TEXT NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_sub ON webauthn_credentials (sub);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge_hash TEXT PRIMARY KEY,
  purpose        TEXT NOT NULL CHECK (purpose IN ('register', 'login')),
  sub            TEXT,
  expires_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires ON webauthn_challenges (expires_at);
