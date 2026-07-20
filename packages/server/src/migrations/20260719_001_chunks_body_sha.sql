-- 20260719_001_chunks_body_sha.sql
-- Cross-path duplicate-embedding dedup (port of KMS migrations/014_vault_chunks_body_sha).
--
-- Why a SECOND hash. content_hash is contentHash() over the chunk's ENRICHED embed text
-- (search/chunk.ts enrichChunkText prepends the note title + heading breadcrumb before the body),
-- and the chunk id itself is keyed on (vault, path, index). Both are path-salted by construction, so
-- the SAME body pasted at two different paths produces different content_hashes AND different chunk
-- ids — it embeds + stores its own vector twice. body_sha is contentHash() over the RAW chunk body
-- alone (the `content` column, PRE-enrichment), which is the key cross-path embedding dedup needs:
-- identical bodies at different paths collide here, so the indexer can embed the first walked copy
-- and reuse/skip the embedding for the rest.
--
-- Additive + backfill-tolerant. A nullable ADD COLUMN is rewrite-free and needs no backfill — rows
-- written before this migration keep NULL. The indexer fills body_sha going forward and DEGRADES
-- GRACEFULLY when the column is absent (an older cache.db, or a bare fixture): the per-run dedup
-- registry is in-memory, so cross-path dedup still works; only the persisted column write is skipped
-- (mirrors the hasDerivedEdgeColumns guard in search/indexer.ts). Inert for retrieval — body_sha is
-- read by no ranking path; it is carried for the dedup fingerprint + audits.

ALTER TABLE chunks ADD COLUMN body_sha TEXT;
CREATE INDEX IF NOT EXISTS chunks_body_sha ON chunks (body_sha);
