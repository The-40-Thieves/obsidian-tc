-- THE-537: the note_quality rollup — one derived row per (vault_id, path).
--
-- Quality signals were scattered across two stores and three access patterns, with no place to ask
-- "which notes are duplicated / orphaned / stale / contradicted". chunks.body_sha in particular is a
-- fingerprint with NO report surface at all — its own migration says so (20260719_001: "Inert for
-- retrieval — body_sha is read by no ranking path"). This is that surface.
--
-- It lives in experiential.db, not cache.db, because it is DERIVED, RESETTABLE, and mixes low-trust
-- usage telemetry with authored metadata — the membrane rule. Keys by value, no cross-file FK,
-- matching the store's existing contract.
--
-- RAW COMPONENTS ARE STORED ALONGSIDE THE SCORE, deliberately. A single opaque number is
-- unreviewable; `score_version` plus the raw columns let the formula change without re-deriving
-- history or lying about old rows. `flags` is what a human actually reads.
--
-- quality_score IS NULL — not 0, not 0.5 — WHEN EVIDENCE IS INSUFFICIENT. Citations are near-zero
-- in practice today, so a naive score would rank the entire vault as low-quality and be worse than
-- nothing. "Unmeasured" and "bad" must stay distinguishable, and only NULL does that.
--
-- NOT THE RANKER. Nothing in the retrieval path reads this table; feeding quality_score into
-- fusion would be a ranking change needing its own eval gate. A test greps for exactly that.

CREATE TABLE note_quality (
  vault_id            TEXT NOT NULL,
  path                TEXT NOT NULL,
  computed_at         INTEGER NOT NULL,

  -- Authored-side components (cache.db).
  chunk_count         INTEGER NOT NULL DEFAULT 0,
  dup_chunk_count     INTEGER NOT NULL DEFAULT 0,   -- chunks whose body_sha appears on another path
  dup_ratio           REAL,                          -- NULL when body_sha is unavailable, not 0
  mtime               INTEGER,
  age_days            REAL,                          -- days since last EDIT (freshness.ts sense)

  -- Usage-side components (experiential.db).
  last_retrieved_at   INTEGER,
  retrievals          INTEGER NOT NULL DEFAULT 0,
  citations           INTEGER NOT NULL DEFAULT 0,
  outcome_balance     INTEGER NOT NULL DEFAULT 0,

  -- Graph-side components (cache.db vault_edges).
  in_degree           INTEGER NOT NULL DEFAULT 0,
  out_degree          INTEGER NOT NULL DEFAULT 0,
  orphan              INTEGER NOT NULL DEFAULT 0,    -- 0/1: no edges in either direction

  contradictions_open INTEGER NOT NULL DEFAULT 0,
  tombstoned          INTEGER NOT NULL DEFAULT 0,    -- 0/1: a forget_log 'tombstone' names this path

  quality_score       REAL,                          -- NULL == unmeasured; see the header
  score_version       INTEGER NOT NULL DEFAULT 1,
  flags               TEXT NOT NULL DEFAULT '[]',    -- JSON array, the human-readable summary

  PRIMARY KEY (vault_id, path)
);

-- The report surface's ordering: worst-scoring first within a vault. NULLs sort separately and are
-- filtered by flag, not by score.
CREATE INDEX idx_note_quality_score ON note_quality(vault_id, quality_score);
CREATE INDEX idx_note_quality_computed ON note_quality(computed_at DESC);
