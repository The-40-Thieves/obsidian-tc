-- 20261008_001_chunk_embeddings_single_active.sql
-- GH #1160: at most ONE active embedding per chunk, enforced by the schema.
--
-- `is_active` has always meant "the chunk's current representation", and the whole read side
-- assumes it is unique: note-plan's `LEFT JOIN chunk_embeddings e ON e.chunk_id = c.id AND
-- e.is_active = 1` resolves a chunk's active_model, ensureVecChunks backfills only
-- `is_active = 1` rows. Nothing enforced it — idx_chunk_embeddings_active (20260519_001) was a
-- plain index — so a writer outside the two ingest paths (an eval/migration loader, a partial
-- operation) could leave two active rows and the join returned an arbitrary one. Observed: the
-- dense index backfilled to 0 rows with every embedding present, and every unchanged note was
-- reported as a "concurrent write" skip on every pass.
--
-- REPAIR RULE for rows already in violation (deterministic, SQL-only, no config needed): keep
-- active the row with the greatest `generated_at` (the most recently generated generation; both
-- ingest writers stamp it on every write), and break an exact tie by the lowest `model` string.
-- (chunk_id, model) is the primary key, so rivals always differ in `model` and the order is total:
-- exactly one row per chunk survives. The configured model is not consulted because a migration
-- runs before config/provider resolution and the stored fingerprint holds the bare model name,
-- not the `provider:model[@rev]` id that chunk_embeddings.model stores. Superseded rows are
-- DEACTIVATED, never deleted (the same audit/rollback stance as THE-531), and an already-inactive
-- row is never promoted. A vec_chunks row for a generation this deactivates is stale by
-- construction and is rebuilt by ensureVecChunks on the next fingerprint change; `doctor` reports
-- vec_chunks against the active-embedding count until then.
UPDATE chunk_embeddings
   SET is_active = 0
 WHERE is_active = 1
   AND EXISTS (
     SELECT 1
       FROM chunk_embeddings o
      WHERE o.chunk_id = chunk_embeddings.chunk_id
        AND o.is_active = 1
        AND o.model != chunk_embeddings.model
        AND (o.generated_at > chunk_embeddings.generated_at
             OR (o.generated_at = chunk_embeddings.generated_at AND o.model < chunk_embeddings.model))
   );

-- Same name, now UNIQUE: a second active row is an immediate constraint error at the offending
-- write. Writers must therefore deactivate the chunk's other-model rows BEFORE activating the new
-- one (persist-note-plan.ts, dedup.ts).
DROP INDEX idx_chunk_embeddings_active;
CREATE UNIQUE INDEX idx_chunk_embeddings_active ON chunk_embeddings(chunk_id) WHERE is_active = 1;
