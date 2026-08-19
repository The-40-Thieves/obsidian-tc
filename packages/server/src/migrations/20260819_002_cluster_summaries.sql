-- 20260819_002_cluster_summaries.sql
-- THE-628 (second PR): the cluster-level (tier-2) summary layer for global/thematic retrieval —
-- RAPTOR-style, over the note-level (tier-1, 20260819_001) summary vectors. Ships DARK — behind
-- retrieval.summaries.enabled (default false), same flag as tier-1 — as the mechanism only. See
-- docs/plans (THE-628 research brief + cluster plan) for the full design.
--
-- `cluster_key` is a hash of the SORTED content_hashes of every member note's note_summaries row
-- (search/cluster-summaries.ts's clusterKeyOf), NOT an arbitrary cluster index. That makes it
-- invalidate on either signal a re-cluster can produce: membership change (a different set of
-- notes lands in the cluster) or content change (a member note's summary was regenerated) both
-- change the sorted content_hash set, hence the key, hence a stale cluster summary is simply never
-- looked up again — no explicit staleness flag needed. A re-cluster whose result reproduces the
-- exact same member set (same content_hashes) reproduces the exact same key, so the resume/skip
-- check in the builder (existingClusterKeys) is a single set-membership test, mirroring tier-1's
-- content_hash resume discipline. Superseded cluster_key rows are NOT garbage-collected by this
-- first PR (the research brief's "cadence recompute, allowed staleness" trade-off, §4) — a
-- follow-up.
--
-- member_count is DERIVED (COUNT of this cluster's rows in cluster_summary_members) but stored
-- redundantly for cheap reporting/telemetry without a join; the members table is the SOURCE OF
-- TRUTH for both the count and — critically — for the mixed-ACL security filter below.
--
-- embedding/embedding_model are nullable for the exact reason note_summaries' are: a cluster
-- summary can be generated (gateway reachable) and then fail to embed (embed provider down), and
-- the row should still be written (advancing the resume/skip check) rather than lost. The
-- retrieval candidate stream only surfaces rows that DO carry an embedding.
CREATE TABLE cluster_summaries (
  vault_id        TEXT NOT NULL,
  cluster_key     TEXT NOT NULL,  -- hash(sorted(member note_summaries.content_hash))
  summary         TEXT NOT NULL,
  model           TEXT NOT NULL,  -- gateway extract-role model that produced this summary
  embedding       BLOB,
  embedding_model TEXT,           -- embeddings provider.id, mirrors note_summaries.embedding_model
  member_count    INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (vault_id, cluster_key)
);
CREATE INDEX idx_cluster_summaries_vault ON cluster_summaries(vault_id);

-- THE MANDATORY SECURITY DESIGN (cluster plan, "THE HARD PART"): a cluster summary is DERIVED
-- FROM MULTIPLE notes with potentially DIFFERENT ACL. Surfacing a cluster summary to a caller who
-- cannot read every one of its member notes leaks the unreadable member's content, even though the
-- cluster_summaries row itself names no single path. This table is the ONLY way the retrieval-time
-- filter (search/cluster-summaries.ts's searchClusterSummaries) can even ASK "can this caller read
-- every member?" — without it, the ACL check has nothing to check against. A cluster whose member
-- paths cannot be resolved (e.g. this table is somehow empty for a cluster_key, which the write
-- path never produces but a filter must still assume can happen) is excluded fail-closed, not
-- fail-open — see that function's own comment.
CREATE TABLE cluster_summary_members (
  vault_id    TEXT NOT NULL,
  cluster_key TEXT NOT NULL,
  path        TEXT NOT NULL,
  PRIMARY KEY (vault_id, cluster_key, path)
);
CREATE INDEX idx_cluster_summary_members_lookup ON cluster_summary_members(vault_id, cluster_key);
