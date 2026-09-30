-- 20260930_001_auth_keys.sql
-- Signing-key registry for locally minted HS256 bearer tokens. More than one key may be valid at
-- the same time, which is what makes a rotation with an overlap window possible: a token names the
-- key that signed it in its `kid` header, and the verifier looks that kid up here.
--
-- No key MATERIAL is stored. `key_ref` is a pointer to where the secret lives: `config` means the
-- deployment's configured auth.jwtSecret (the reserved kid `config`), `file:<name>` means a 0600
-- file under `<cacheDir>/auth-keys/`. A cache.db that leaks (or is copied into a bug report)
-- therefore carries no way to forge a token.
--
-- state machine: active -> retiring -> retired. `retire_after` (epoch ms) is set when a key leaves
-- `active`; a `retiring` key still verifies until that instant, after which it is refused whether
-- or not anything has yet rewritten the row to `retired`. An empty table means the registry has
-- never been used and the configured secret is the only key, exactly as before this table existed.
CREATE TABLE IF NOT EXISTS auth_keys (
  kid          TEXT PRIMARY KEY,
  alg          TEXT NOT NULL DEFAULT 'HS256',
  key_ref      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('active', 'retiring', 'retired')),
  retire_after INTEGER
);

-- At most one key may be `active`: rotation moves the old one out in the same transaction that
-- inserts the new one, and this index turns a racing second rotation into an error instead of two
-- signers.
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_keys_one_active ON auth_keys (state) WHERE state = 'active';
