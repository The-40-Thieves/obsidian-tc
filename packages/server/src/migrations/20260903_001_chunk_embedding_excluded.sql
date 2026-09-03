-- 20260903_001_chunk_embedding_excluded.sql
-- THE-934: `egress.excludePaths` marks vault-relative globs whose chunks must never reach the
-- inference gateway or the embedding provider. An excluded chunk is still chunked, stored and
-- FTS/regex-searchable -- only its dense/sparse/ColBERT vectors are withheld -- so it carries NO
-- row in chunk_embeddings, which is exactly what the audit job's null-embedding check (audit.ts)
-- already flags as a defect. Without a marker, turning on an exclusion list would make the audit
-- job report every excluded chunk as broken forever.
--
-- `embedding_excluded` distinguishes "never embedded on purpose" from "embedding failed/pending".
-- NOT NULL DEFAULT 0 so every pre-existing chunk reads as the (correct) non-excluded default with
-- no backfill needed -- the flag only ever matters going forward, re-evaluated on each index pass
-- (see note-plan.ts's computeNotePlan, which forces a re-plan whenever a chunk's current path
-- exclusion status differs from this stored value, so a renamed-into or renamed-out-of folder is
-- picked up on the next reconcile rather than staying stuck at whatever an earlier pass decided).

ALTER TABLE chunks ADD COLUMN embedding_excluded INTEGER NOT NULL DEFAULT 0;
