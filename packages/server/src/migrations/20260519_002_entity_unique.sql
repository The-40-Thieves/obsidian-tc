-- 20260519_002_entity_unique — F4: enforce the entity natural key
-- (vault_id, entity_type, name) at the DB level to close the create_entity
-- read-then-insert race. Pre-existing duplicates are merged into the earliest
-- (MIN rowid) row. Relations are repointed onto the survivor BEFORE the dedup
-- DELETE, so the ON DELETE CASCADE FKs do not drop edges that belonged to a
-- duplicate (review #5); then the unique index is created.

-- Repoint outgoing edges of a duplicate onto its surviving sibling. UPDATE OR IGNORE
-- drops a repoint that would collide with an existing (source,target,type) edge.
UPDATE OR IGNORE memory_relations
SET source_id = (
  SELECT keep.id
  FROM memory_entities dup
  JOIN memory_entities keep
    ON keep.vault_id = dup.vault_id
   AND keep.entity_type = dup.entity_type
   AND keep.name = dup.name
  WHERE dup.id = memory_relations.source_id
  ORDER BY keep.rowid
  LIMIT 1
)
WHERE source_id IN (
  SELECT id FROM memory_entities
  WHERE rowid NOT IN (SELECT MIN(rowid) FROM memory_entities GROUP BY vault_id, entity_type, name)
);

-- Repoint incoming edges likewise.
UPDATE OR IGNORE memory_relations
SET target_id = (
  SELECT keep.id
  FROM memory_entities dup
  JOIN memory_entities keep
    ON keep.vault_id = dup.vault_id
   AND keep.entity_type = dup.entity_type
   AND keep.name = dup.name
  WHERE dup.id = memory_relations.target_id
  ORDER BY keep.rowid
  LIMIT 1
)
WHERE target_id IN (
  SELECT id FROM memory_entities
  WHERE rowid NOT IN (SELECT MIN(rowid) FROM memory_entities GROUP BY vault_id, entity_type, name)
);

DELETE FROM memory_entities
WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM memory_entities GROUP BY vault_id, entity_type, name
);

CREATE UNIQUE INDEX idx_memory_entities_natural_key
  ON memory_entities(vault_id, entity_type, name);
