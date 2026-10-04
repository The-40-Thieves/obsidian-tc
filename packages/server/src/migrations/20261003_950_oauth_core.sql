-- 20261003_950_oauth_core.sql
-- oauth.db chain (NOT cache.db, NOT auth.db). State of the bundled OAuth 2.1 authorization server
-- (`auth.as`): the operator account, login sessions, registered clients, pending authorization
-- requests, grants, authorization codes, refresh-token families and the access-token jtis issued from
-- them. A fourth store, deliberately: auth.db is the signing-key and revocation registry and must
-- survive a cache wipe; this state has a different profile. Losing oauth.db is FAIL-SAFE: every
-- grant, refresh token, dynamically registered client and the operator password vanish, so clients
-- sign in again after the account is re-claimed, access tokens already issued expire within
-- `auth.as.accessTokenSeconds`, and revocations stay in auth.db. So it needs no lost-registry
-- marker; it does need backing up beside auth.db and auth-keys/.
--
-- Every secret column holds a SHA-256 hex digest, never the secret (codes, refresh tokens, session
-- ids, request handles). Every time is epoch milliseconds. This slice creates the schema and the
-- housekeeping that prunes it; the routes that write most of it arrive in later slices.
--
-- Garbage collection (auth/oauth-db.ts `gcOauthDb`) deletes: expired requests, codes, sessions and
-- metadata-document cache rows; dynamically registered clients unused past `auth.as.dcr.unusedDays`;
-- refresh families past their absolute cap; access-token jtis past their expiry.
CREATE TABLE IF NOT EXISTS users (
  sub            TEXT PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  scopes_allowed TEXT,
  vaults_allowed TEXT,
  created_at     INTEGER NOT NULL,
  disabled_at    INTEGER
);

-- At most one row (id = 1): when the AS was claimed, and the SHA-256 of the setup token that did it.
CREATE TABLE IF NOT EXISTS setup_state (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  claimed_at            INTEGER,
  setup_token_hash_used TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash      TEXT PRIMARY KEY,
  sub          TEXT NOT NULL REFERENCES users (sub) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- Dynamically registered clients only. Static clients live in config, metadata-document clients in
-- cimd_cache.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('dcr')),
  metadata_json TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  expires_at    INTEGER,
  created_ip    TEXT
);

CREATE TABLE IF NOT EXISTS cimd_cache (
  client_id     TEXT PRIMARY KEY,
  document_json TEXT NOT NULL,
  fetched_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cimd_cache_expires ON cimd_cache (expires_at);

CREATE TABLE IF NOT EXISTS auth_requests (
  handle_hash    TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  scope          TEXT NOT NULL,
  resource       TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  state          TEXT,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_requests_expires ON auth_requests (expires_at);

CREATE TABLE IF NOT EXISTS grants (
  id           TEXT PRIMARY KEY,
  sub          TEXT NOT NULL,
  client_id    TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope        TEXT NOT NULL,
  resource     TEXT NOT NULL,
  persona      TEXT,
  vault        TEXT,
  created_at   INTEGER NOT NULL,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_grants_consent ON grants (client_id, redirect_uri, sub);

CREATE TABLE IF NOT EXISTS auth_codes (
  code_hash      TEXT PRIMARY KEY,
  grant_id       TEXT NOT NULL REFERENCES grants (id) ON DELETE CASCADE,
  request_scope  TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  resource       TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at     INTEGER NOT NULL,
  used_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_auth_codes_expires ON auth_codes (expires_at);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash              TEXT PRIMARY KEY,
  family_id               TEXT NOT NULL,
  grant_id                TEXT NOT NULL REFERENCES grants (id) ON DELETE CASCADE,
  parent_hash             TEXT,
  scope                   TEXT NOT NULL,
  issued_at               INTEGER NOT NULL,
  successor_first_used_at INTEGER,
  family_expires_at       INTEGER NOT NULL,
  revoked_at              INTEGER
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens (family_expires_at);

-- The jti of every access token issued from a family, so reusing a code or a refresh token can
-- revoke the tokens already out. Only useful until the access token itself expires.
CREATE TABLE IF NOT EXISTS issued_access (
  jti        TEXT PRIMARY KEY,
  family_id  TEXT NOT NULL,
  grant_id   TEXT NOT NULL REFERENCES grants (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_issued_access_family ON issued_access (family_id);
CREATE INDEX IF NOT EXISTS idx_issued_access_expires ON issued_access (expires_at);
