-- 20260519_002_entity_unique — F4: enforce the entity natural key
-- (vault_id, entity_type, name) at the DB level to close the create_entity
-- read-then-insert race. Dedup any pre-existing duplicates (keep the earliest
-- rowid; orphaned relations are removed by the ON DELETE CASCADE FKs) BEFORE
-- creating the unique index, or index creation would throw on existing dups.

DELETE FROM memory_entities
WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM memory_entities GROUP BY vault_id, entity_type, name
);

CREATE UNIQUE INDEX idx_memory_entities_natural_key
  ON memory_entities(vault_id, entity_type, name);
