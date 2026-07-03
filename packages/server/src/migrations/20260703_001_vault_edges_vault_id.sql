-- 20260703_001_vault_edges_vault_id.sql
-- THE-310: add vault_id to vault_edges so multi-vault GraphRAG is isolated.
--
-- vault_edges (20260626_001) predates the shared cache.db logical vault_id isolation that
-- chunks/notes/embeddings carry. Without it, reconcileVaultEdges() -- a full-state reconcile
-- run once per index_vault pass -- deletes another vault's wikilink edges, and the graph walk
-- (graph_expand) crosses vaults. Edges are a rebuildable derived cache, so rather than backfill
-- an unknowable vault_id we clear the unscoped rows; the next index_vault per vault repopulates
-- them scoped. The unique index is recreated to include vault_id so two vaults can hold the same
-- path-pair edge; a vault_id index backs the scoped SELECT/DELETE and the graph walk.

DELETE FROM vault_edges;
ALTER TABLE vault_edges ADD COLUMN vault_id TEXT NOT NULL DEFAULT '';
DROP INDEX IF EXISTS idx_vault_edges_unique;
CREATE UNIQUE INDEX idx_vault_edges_unique ON vault_edges(vault_id, source_path, target_path, edge_type);
CREATE INDEX IF NOT EXISTS idx_vault_edges_vault ON vault_edges(vault_id);
