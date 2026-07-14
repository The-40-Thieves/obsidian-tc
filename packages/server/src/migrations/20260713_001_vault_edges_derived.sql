-- 20260713_001_vault_edges_derived.sql
-- Graph densification (graphify spec-donor port): derived edges beyond the literal wikilink layer.
-- See docs/plans/2026-07-13-graph-densification.md.
--
-- Adds two nullable columns so derived edges (edge_kind 'virtual'/'derived') can carry a confidence
-- and a content fingerprint of their cited source. Existing literal `links_to`/`unresolved` rows keep
-- NULL for both (the wikilink layer is confidence 1.0 by construction, no fingerprint). Nullable
-- ADD COLUMN is a rewrite-free, backfill-free migration; the reconcile paths write the columns
-- explicitly. The unique index already keys on edge_type, so derived edge_types (shared_tag,
-- similar_to, semantically_similar_to) coexist with the literal rows without a schema change.
--
-- source_fingerprint: a hash of the cited source note's content at extraction time. A derived edge
-- whose source later changes self-flags "stale, re-verify" (graphify content-fingerprint pattern)
-- rather than presenting as authoritative. Never read by the graph walk; carried for the staleness
-- sweep + audits.
--
-- TRIPWIRE: still plain graph structure. No claim atoms / authoritative_claims / derives_from — that
-- is the THE-235 typed-atom substrate, downstream of this.

ALTER TABLE vault_edges ADD COLUMN confidence REAL;
ALTER TABLE vault_edges ADD COLUMN source_fingerprint TEXT;
