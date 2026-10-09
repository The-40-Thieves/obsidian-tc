-- 20261009_954_credential_generation.sql
-- oauth.db chain (NOT cache.db, NOT auth.db). A per-user credential generation (design v2 section
-- 4.11.5, slice S10 review round 1).
--
-- `auth as reset-credentials` and `auth as set-password` change the password, end every session and
-- (the reset) delete the passkeys. A request that had looked at its session BEFORE that and writes
-- AFTER it (a passkey registration parked in the attestation check, a consent parked between the
-- session lookup and the grant write) would otherwise write on behalf of a session that no longer
-- exists. Both commands bump `users.credential_gen` in the same transaction as the rest; a session
-- records the generation it was opened under (`sessions.credential_gen`), and every write made on a
-- session's authority re-checks, inside its own write transaction, that the session row is still
-- there and its generation is still the user's.
--
-- Existing users and sessions both start at 0, so nothing opened before this migration is ended by it.
ALTER TABLE users ADD COLUMN credential_gen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN credential_gen INTEGER NOT NULL DEFAULT 0;
