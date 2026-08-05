-- THE-733: persist the calibrated score distribution PER VAULT, so a percentile exists at query
-- time. Today `gaps --calibrate` computes a full ScoreDistribution, prints it for a human, and
-- returns -- that print is the distribution's entire lifetime. Nothing can read a per-vault
-- percentile from the request path.
--
-- WHY THIS IS NOT A COSMETIC GAP. A fused RRF score is not comparable across vaults, which is the
-- whole reason THE-631 asks for a percentile rather than a raw score. The only number reachable
-- from the request path today is DEFAULT_GAP_THRESHOLD -- a module constant carried from an n=136
-- calibration on ONE vault at one point in time. Building a confidence signal on that produces a
-- number that varies across vaults for reasons unconnected to those vaults, which THE-631 itself
-- condemns in advance: "a confidence number computed from another vault's percentiles is worse
-- than no confidence number, because it looks authoritative."
--
-- WHY NOT REUSE gap_reports (20260729_001). It is the obvious candidate and does not fit: it
-- carries a SCALAR `threshold`, and that scalar is the global default rather than a calibration.
-- A distribution is nine numbers plus the provenance needed to know whether they still apply.
--
-- APPEND-ONLY, one row per calibration, on the gap_reports precedent. Recalibration history is
-- itself useful ("did this vault's score distribution shift when the engine changed?"), and the
-- read side always wants the LATEST row for a vault.
--
-- experiential.db under the admission test in migration-manifest.ts: the contents are DERIVED
-- (a rollup over observed retrieval scores) rather than AUTHORED, and losing the file costs a
-- recalibration rather than vault content.
--
-- PROVENANCE IS NOT OPTIONAL, and it is why this table has more than percentiles. gaps.ts already
-- warns to "re-calibrate with --calibrate after engine changes". A distribution is only valid for
-- the engine and retrieval configuration that produced it, so a stale calibration must be
-- DETECTABLE rather than silently applied -- the same inferred-versus-observed distinction that
-- runs through THE-720, THE-688 and THE-717. `engine_version` is compared at read time; a mismatch
-- does not discard the calibration, it flags it, because a slightly stale percentile is still far
-- better grounded than a foreign vault's constant.
--
-- `config_fingerprint` is NULLABLE on purpose. A NULL means "not recorded", which is honestly
-- different from "recorded and matching" -- writing a placeholder would make an uncalibrated
-- provenance indistinguishable from a verified one.

CREATE TABLE score_calibration (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_id       TEXT    NOT NULL,
  computed_at    INTEGER NOT NULL,
  -- How many queries the distribution was measured over. A percentile from n=3 is not a
  -- percentile; the read side refuses below a floor rather than serving a confident nonsense.
  n              INTEGER NOT NULL,
  min            REAL    NOT NULL,
  p5             REAL    NOT NULL,
  p10            REAL    NOT NULL,
  p25            REAL    NOT NULL,
  median         REAL    NOT NULL,
  p75            REAL    NOT NULL,
  p90            REAL    NOT NULL,
  p95            REAL    NOT NULL,
  -- Server version that produced it. Compared at read time so a calibration from a different
  -- engine is flagged, not silently trusted.
  engine_version TEXT    NOT NULL,
  -- Retrieval-config fingerprint. NULL = not recorded, which is distinct from recorded-and-equal.
  config_fingerprint TEXT
);

-- The read pattern: latest calibration for a vault.
CREATE INDEX idx_score_calibration_vault ON score_calibration(vault_id, computed_at DESC);
