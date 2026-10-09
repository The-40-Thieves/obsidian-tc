-- 20261009_001_index_acl_path.sql
-- The index stored the path a note was WALKED under (the display path), and every DB-backed result
-- was authorized on that name. Through a symlinked folder (`wiki -> private`) the two differ: a
-- caller whose lexical ACL admits `wiki/**` was handed a row for `private/x.md`, a note the same ACL
-- refuses to read directly; and with `shared -> pages` and only `pages/**` readable, the reverse
-- failure: the row was indexed (its target is readable) but search rejected its `shared/...` name.
--
-- `acl_path` is the ACL identity of the row: the symlink-resolved, vault-relative path, computed the
-- way the ACL resolves a path (vault/paths.ts resolveVaultPathChecked). `path` stays the display
-- name every result is shown under. Every stored-row read filters on `acl_path`
-- (vault/stored-acl-path.ts); the indexer sets it with the row and re-syncs it on every pass.
--
-- FAIL CLOSED. A row whose `acl_path` is NULL (or '', what a writer that could not resolve the path
-- stores) is UNRESOLVED and is returned to nobody. That is every row that existed when this
-- migration ran (its stored name may be an alias for a note the reader cannot see, and SQL cannot
-- tell which) and any row a writer forgot to stamp. The next index pass resolves each against the
-- vault with a metadata-only write (no re-embedding) and sets the real value; until then it is
-- hidden, not trusted.
--
-- Additive: a nullable ADD COLUMN is rewrite-free. The partial indexes hold only rows whose identity
-- is not their own name (aliases and unresolved rows), which is what a reader loads per call.

ALTER TABLE chunks ADD COLUMN acl_path TEXT;
ALTER TABLE notes ADD COLUMN acl_path TEXT;

CREATE INDEX IF NOT EXISTS idx_chunks_acl_alias
  ON chunks (vault_id, path, acl_path) WHERE acl_path IS NULL OR acl_path <> path;
CREATE INDEX IF NOT EXISTS idx_notes_acl_alias
  ON notes (vault_id, path, acl_path) WHERE acl_path IS NULL OR acl_path <> path;
