-- THE-538: retrieval POLICY provenance. chunk_retrievals records what was returned and where it
-- ranked, but nothing about HOW it was ranked — GraphSearchResult.source (seed/expansion/lexical/
-- sparse/temporal) was discarded at every call site, and the fusion configuration was never
-- recorded at all. Without those, no outcome in chunk_retrievals can be attributed to a fusion
-- configuration, which makes any later weight-learning work not merely noisy but UNIDENTIFIABLE.
--
-- Pure instrumentation: this migration adds no exploration arm and randomizes nothing. `arm` is
-- always 'control' and `propensity` always 1.0 today. `propensity` is stored anyway because it is
-- the one field that CANNOT be reconstructed after the fact — the probability with which the
-- serving policy chose this configuration is only knowable at decision time, and its absence is
-- exactly what would make a later offline fit unsound. Logging a constant 1.0 now costs 8 bytes a
-- row and keeps that door open.
--
-- GROWTH: one row per SEARCH CALL, against chunk_retrievals' one row per RETURNED CHUNK — so this
-- table grows ~1/K as fast as the log it annotates (K = top-K, typically 10–30). Both are
-- deliberately append-only and kept for audit/research (see 20260723_001_activation_watermark.sql),
-- and neither has a retention owner. At a heavy 1,000 searches/day this table adds roughly 0.1 MB
-- and chunk_retrievals roughly 3 MB per day. Unbounded log growth is tracked separately; this
-- migration makes the smaller half of it explicit rather than introducing a new unowned cost.

CREATE TABLE retrieval_policy (
  event_group   TEXT PRIMARY KEY,   -- one id per search call; stamped onto that call's chunk_retrievals rows
  ts            INTEGER NOT NULL,
  vault_id      TEXT,               -- chunk_retrievals has no vault_id; it is carried here
  surface_type  TEXT,               -- the serve surface (tool name), mirroring chunk_retrievals
  policy_id     TEXT,               -- 'static' | 'idf' | 'learned:v3'
  arm           TEXT,               -- always 'control' in THE-538
  dense_w       REAL,
  lex_w         REAL,
  sparse_w      REAL,
  fusion_mode   TEXT,
  rrf_k         INTEGER,
  route_class   TEXT,
  propensity    REAL                -- always 1.0 here; see the header on why it is stored anyway
);

CREATE INDEX idx_retrieval_policy_ts ON retrieval_policy(ts DESC);
CREATE INDEX idx_retrieval_policy_vault ON retrieval_policy(vault_id) WHERE vault_id IS NOT NULL;

-- Nullable ADD COLUMN is rewrite-free and back-compatible (the body_sha precedent,
-- 20260719_001_chunks_body_sha.sql): an existing experiential.db migrates forward in place and its
-- pre-THE-538 rows simply carry NULL in both columns.
ALTER TABLE chunk_retrievals ADD COLUMN event_group TEXT;
ALTER TABLE chunk_retrievals ADD COLUMN stream_source TEXT;

CREATE INDEX IF NOT EXISTS idx_chunk_retrievals_event_group
  ON chunk_retrievals(event_group) WHERE event_group IS NOT NULL;
