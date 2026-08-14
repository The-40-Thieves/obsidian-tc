-- 20260814_001_memory_entity_status.sql
-- THE-833: memory entities can be created but never retired. External reporter (GitHub #787)
-- declined to model a ~120-item tool inventory / link registry as entities specifically BECAUSE
-- those items retire and there was no cleanup path -- they built Dataview notes instead and lost
-- the typed-relation graph. This column is the primary path THE-833 ships: a soft, reversible
-- "not current" flag that preserves the append-only philosophy (nothing is destroyed), with
-- get_entity / query_entity_graph filtering it out by default and an explicit opt-in to see it.
--
-- Two values only ('active' | 'retired'), enforced at the SQLite layer with a CHECK rather than
-- left to application code alone -- the same defense-in-depth the rest of this schema uses for
-- closed unions (e.g. memory_relations' composite PK). NOT NULL DEFAULT 'active' means every
-- existing row is retroactively "active", which is the correct reading: nothing before this
-- migration was ever retired, because the capability did not exist.
ALTER TABLE memory_entities ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'retired'));

CREATE INDEX idx_memory_entities_status ON memory_entities(vault_id, status);
