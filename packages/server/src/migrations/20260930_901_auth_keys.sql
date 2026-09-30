-- 20260930_901_auth_keys.sql
-- auth.db chain (NOT cache.db). Signing-key registry for locally minted HS256 bearer tokens. More
-- than one key may be valid at the same time, which is what makes a rotation with an overlap window
-- possible: a token names the key that signed it in its `kid` header, and the verifier looks that
-- kid up here.
--
-- This lives in its own file, <cacheDir>/auth.db, because it is AUTHORED operator state (an
-- operator's decision to retire a key) and NOT regenerable: cache.db is documented as disposable
-- and operators are told to `rm cache.db*`. Losing this table un-retires keys. The verifier
-- therefore refuses, rather than falling back to the configured secret, when the registry has
-- ever been initialised and this file is missing or empty (auth/registry.ts).
--
-- No key MATERIAL is stored. `key_ref` is a pointer to where the secret lives: `config` means the
-- deployment's configured auth.jwtSecret (the reserved kid `config`), `file:<name>` means a 0600
-- file under `<cacheDir>/auth-keys/`. An auth.db that leaks (or is copied into a bug report)
-- therefore carries no way to forge a token.
--
-- state machine: active -> retiring -> retired. `retire_after` (epoch ms) is set when a key leaves
-- `active`; a `retiring` key still verifies until that instant, after which it is refused whether
-- or not anything has yet rewritten the row to `retired`. A `retiring` row with no `retire_after`
-- is refused by the CHECK below, and treated as retired by the verifier if one ever appears. An
-- empty table in a deployment that never initialised the registry means the configured secret is
-- the only key, exactly as before this table existed.
CREATE TABLE IF NOT EXISTS auth_keys (
  kid          TEXT PRIMARY KEY,
  alg          TEXT NOT NULL DEFAULT 'HS256',
  key_ref      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('active', 'retiring', 'retired')),
  retire_after INTEGER,
  CHECK (state <> 'retiring' OR retire_after IS NOT NULL)
);

-- At most one key may be `active`: rotation moves the old one out in the same transaction that
-- inserts the new one, and this index turns a racing second rotation into an error instead of two
-- signers.
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_keys_one_active ON auth_keys (state) WHERE state = 'active';
