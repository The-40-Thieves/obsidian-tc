-- 20260626_001_experiential_init.sql
-- THE-233 (W-SCHEMA): the experiential tier -- a PHYSICALLY SEPARATE store (experiential.db),
-- NOT a partition of cache.db. The membrane (see decision
-- 2026-06-26-experiential-tier-write-on-gate): low-trust per-retrieval state lives in its
-- own file so an injected / auto-captured episode can never FK into an authored atom,
-- poisoning blast radius is capped at the store boundary, and a reset is a file truncate
-- rather than a filtered delete. Because chunks live in cache.db, object_id / chunk_id
-- reference chunk ids BY VALUE (no cross-file foreign key -- this is the membrane).
--
-- Holds only NON-RECONSTRUCTABLE keep-state: engram activation history + retrieval feedback.
-- Authored chunks are re-indexed from the vault, never imported (thin-merge decision).
-- Behavior-preserving port of KMS vault_object_state (migration 017) + chunk_retrievals (018).
--
-- PRAGMAs (foreign_keys, journal_mode = WAL) are set per-connection by the runtime.
-- The migration runner pre-creates schema_migrations; it is not declared here.
--
-- TRIPWIRE: valid_from / valid_until are the EXISTING KMS 2-timestamp validity, loaded
-- as-is. This is NOT the engine-build 4-timestamp bi-temporal substrate; no claim atoms,
-- authoritative_claims, or derives_from (THE-235, downstream).

-- ACT-R / engram activation state, one row per chunk (object).
CREATE TABLE vault_object_state (
  object_id               TEXT PRIMARY KEY,          -- chunk id, by value (membrane: no cross-file FK)
  retrieval_strength      REAL,
  storage_strength        REAL,
  frequency               INTEGER NOT NULL DEFAULT 0,
  last_accessed           INTEGER,
  learned_at              INTEGER,
  valid_from              INTEGER,                   -- existing KMS 2-timestamp validity (loaded as-is)
  valid_until             INTEGER,
  emotional_weight        REAL NOT NULL DEFAULT 5,   -- KMS default 5 (1-10 modulates ACT-R decay)
  confidence              REAL,
  injections              INTEGER NOT NULL DEFAULT 0,
  hits                    INTEGER NOT NULL DEFAULT 0,
  misses                  INTEGER NOT NULL DEFAULT 0,
  last_hit_at             INTEGER,
  cached_activation_score REAL,
  last_computed_at        INTEGER
);

CREATE INDEX idx_vault_object_state_activation
  ON vault_object_state(cached_activation_score)
  WHERE cached_activation_score IS NOT NULL;

-- Append-only retrieval event log; feeds the nightly activation recompute (sleep-time plane).
CREATE TABLE chunk_retrievals (
  id                TEXT PRIMARY KEY,                -- retrieval event id, by value
  chunk_id          TEXT NOT NULL,                   -- chunk id, by value (membrane: no cross-file FK)
  retrieved_at      INTEGER NOT NULL,
  session_id        TEXT,
  surface_type      TEXT,                            -- which surface / client retrieved it
  query_text        TEXT,
  rank_in_results   INTEGER,
  rerank_score      REAL,                            -- rerank passthrough score (D1); was KMS cohere_score
  cited_in_response INTEGER,                         -- nullable 0/1
  citation_score    REAL,
  feedback          INTEGER                          -- -1 | 0 | +1
);

CREATE INDEX idx_chunk_retrievals_chunk   ON chunk_retrievals(chunk_id, retrieved_at DESC);
CREATE INDEX idx_chunk_retrievals_session ON chunk_retrievals(session_id) WHERE session_id IS NOT NULL;
