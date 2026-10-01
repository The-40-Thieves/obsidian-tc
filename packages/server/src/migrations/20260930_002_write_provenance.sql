-- 20260930_002_write_provenance.sql
-- Signed write provenance: one row per committed mutating tool call, hash-chained per vault and
-- signed with the auth registry's EdDSA signing key. The row stores HASHES of note content
-- (never content, never prompts) and WHO/WHERE attribution, every field tagged verified or
-- self_reported inside `body`.
--
-- `body` is the canonical JSON the hash covers; the other columns only index it. `verify` rechecks
-- that every indexed column equals its value inside `body`, so editing a column cannot hide.
--
-- Lives in cache.db beside event_log/note_snapshots (an AUDIT store), but unlike them it is not a
-- cache: losing rows loses the answer to "who changed this". Retention is an explicit operator
-- knob (provenance.retentionDays); pruned heads are anchored in write_provenance_heads.
CREATE TABLE write_provenance (
  vault_id  TEXT    NOT NULL,
  seq       INTEGER NOT NULL,            -- 1-based, dense per vault
  ts        INTEGER NOT NULL,            -- epoch ms
  body      TEXT    NOT NULL,            -- canonical JSON (hashed)
  prev_hash TEXT    NOT NULL,            -- hash of seq-1 (or the pruned-through hash / genesis)
  hash      TEXT    NOT NULL,            -- sha256 hex over body (which embeds prev_hash)
  kid       TEXT,                        -- signing key id; NULL when no asymmetric key was available
  sig       TEXT,                        -- base64url EdDSA signature over the hash; NULL iff kid NULL
  PRIMARY KEY (vault_id, seq)
) WITHOUT ROWID;
CREATE INDEX idx_write_provenance_ts ON write_provenance (ts);

-- One row per vault: the signed chain head (catches a removed TAIL record, which the chain alone
-- cannot) and the signed prune anchor (what retention removed, so the surviving prefix still
-- verifies and a silently dropped prefix does not).
CREATE TABLE write_provenance_heads (
  vault_id    TEXT    PRIMARY KEY,
  head_seq    INTEGER NOT NULL,
  head_hash   TEXT    NOT NULL,
  pruned_seq  INTEGER NOT NULL DEFAULT 0,
  pruned_hash TEXT    NOT NULL,          -- genesis (64 zeros) until something is pruned
  kid         TEXT,
  sig         TEXT
);
