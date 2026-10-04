-- 20261003_904_auth_keys_purpose.sql
-- auth.db chain (NOT cache.db). A signing key now has a PURPOSE, so the bundled authorization
-- server's access-token key and the operator's hand-minting key can both be active at once and
-- rotate independently.
--
--   mint  every key this registry held before this migration: HS256 (the configured secret, or a
--         file key) or an asymmetric key, signing the tokens `obsidian-tc token mint` prints. The
--         DEFAULT, so every existing row reads `mint` with no rewrite and a deployment that never
--         enables the authorization server sees no change.
--   as    the authorization server's RFC 9068 access-token key: ES256 or EdDSA only (enforced by
--         the registry, not here), verified under rules of its own (issuer, typ, client_id, aud, jti).
--
-- The one-active-key index becomes one active key PER PURPOSE. Without that, the first rotation of
-- an `as` key would retire the operator's HS256 key and every hand-minted token would die once its
-- grace window ended. Rotation still moves the old key out in the same transaction that inserts the
-- new one, so a racing second rotation within a purpose is still an error rather than two signers.
--
-- Private key material is unchanged: it stays in a 0600 file under `<cacheDir>/auth-keys/`, never
-- here. An `as` key's file is named `as-<kid>.key`, which is how the keys directory tells the two
-- purposes apart when auth.db is lost (see auth/registry-markers.ts).
ALTER TABLE auth_keys ADD COLUMN purpose TEXT NOT NULL DEFAULT 'mint' CHECK (purpose IN ('mint', 'as'));

DROP INDEX IF EXISTS idx_auth_keys_one_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_keys_one_active_per_purpose ON auth_keys (purpose) WHERE state = 'active';
