-- 20260723_001_activation_watermark.sql
-- THE-461: incremental ACT-R activation recompute. recomputeActivation read the ENTIRE
-- chunk_retrievals log on every timer pass; that full-history scan grows unbounded with retrieval
-- volume and competes with interactive dispatch. A one-row watermark records the max
-- chunk_retrievals rowid already folded into the cached activation scores, so an incremental pass
-- reconciles only chunks with events past it. chunk_retrievals is append-only (kept for
-- audit/research), so rowid is monotonic and race-free as the watermark. The exact ACT-R formula is
-- unchanged — this avoids the rescan, not the math (approximations like Petrov 2006 would change
-- retrieval behaviour and are out of scope). Watermark 0 (the seed) makes the first pass a full one.
CREATE TABLE IF NOT EXISTS activation_state (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  watermark INTEGER NOT NULL DEFAULT 0
);
INSERT INTO activation_state (id, watermark) VALUES (1, 0)
  ON CONFLICT(id) DO NOTHING;
