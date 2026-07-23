-- 20260723_001_vault_generation.sql
-- THE-496: a monotonic per-vault generation counter, bumped on every mutation that can change query
-- results (chunk upserts/deletes, edge/densification changes — all of which flow through the index
-- write paths). It is one half of the query-cache key (THE-497); the other half is the per-caller ACL
-- fingerprint (aclFingerprint, in code). Content changes bump the generation; ACL/scope changes are
-- captured by the fingerprint, so together they invalidate every result-affecting change. A missed
-- bump would silently serve stale cached results, so the bump lives INSIDE each index write
-- transaction. Absent row reads as generation 0.
CREATE TABLE IF NOT EXISTS vault_generation (
  vault_id   TEXT PRIMARY KEY,
  generation INTEGER NOT NULL DEFAULT 0
);
