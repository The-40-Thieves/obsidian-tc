-- 20260626_001_vault_edges.sql
-- THE-233 (W-SCHEMA): wikilink edge graph for GraphRAG.
--
-- The ported vault_graph_expand walks this edge table (KMS migrations 005/011/013).
-- Edges are authored / derived from vault wikilinks, so they live in the main cache.db
-- alongside chunks. Path-based (a wikilink is note -> note); the graph walk joins edges
-- to chunks by path. Behavior-preserving port of the KMS vault_edges shape (Postgres)
-- onto SQLite. SQLite has full recursive CTEs, so the expand walk ports directly; only
-- the pgvector distance operator becomes a sqlite-vec / in-process call (retrieval slice).
--
-- PRAGMAs (foreign_keys, journal_mode = WAL) are set per-connection by the runtime.
--
-- TRIPWIRE: plain graph structure only. No claim atoms, authoritative_claims,
-- derives_from, or bi-temporal columns -- that is the engine-build typed-atom substrate
-- (THE-235), downstream of this merge.

CREATE TABLE vault_edges (
  source_path  TEXT NOT NULL,                       -- vault-relative note path (edge tail)
  target_path  TEXT NOT NULL,                       -- vault-relative note path (edge head)
  edge_type    TEXT NOT NULL,                       -- relation verb, e.g. "links_to" | "embed" | "tag"
  edge_kind    TEXT NOT NULL DEFAULT 'literal',     -- 'literal' (wikilink) | 'virtual' (cosine neighbor)
  provenance   TEXT,                                -- how the edge was derived, e.g. "wikilink" | "graph_expand"
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Dedup identical edges regardless of insert order (mirrors KMS unique(source, target, type)).
CREATE UNIQUE INDEX idx_vault_edges_unique ON vault_edges(source_path, target_path, edge_type);
CREATE INDEX idx_vault_edges_source ON vault_edges(source_path);
CREATE INDEX idx_vault_edges_target ON vault_edges(target_path);
CREATE INDEX idx_vault_edges_kind   ON vault_edges(edge_kind);
