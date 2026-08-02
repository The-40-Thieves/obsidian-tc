-- 20260802_001_acl_path_sets.sql
-- THE-694/695: the read-ACL predicate, made visible to SQLite.
--
-- Three retrieval paths compute an aggregate over the whole corpus and hand the result to a caller
-- who can only see part of it. Fixing that needs the authorization boundary visible to SQL, which
-- the cross-adapter Database interface cannot otherwise provide: bun:sqlite (what production runs)
-- exposes no user-defined function registration at all — measured, not assumed — so a scalar
-- predicate is not an option and a joinable table is.
--
-- PATH-keyed, not chunk-keyed: readableRel is a pure function of the path, so this holds 1,146 rows
-- on the live vault rather than 13,486, and still serves chunks (join path), vault_edges (join
-- source_path/target_path) and notes (join path).
--
-- The UNIQUE key deliberately EXCLUDES generation: a regenerated set replaces its predecessor in
-- place, so growth is bounded by distinct ACL fingerprints rather than by index generations, which
-- is what makes an LRU cap meaningful.
CREATE TABLE IF NOT EXISTS acl_path_sets (
  set_id          INTEGER PRIMARY KEY,
  acl_fingerprint TEXT    NOT NULL,
  vault_id        TEXT    NOT NULL,
  generation      INTEGER NOT NULL,
  built_at        INTEGER NOT NULL,
  path_count      INTEGER NOT NULL,
  UNIQUE (acl_fingerprint, vault_id)
);

-- The surrogate set_id exists for ROW SIZE. WITHOUT ROWID wants average rows under 1/20 of a page;
-- page_size is 4096, so the budget is 204.8 bytes. Repeating the 64-char SHA-256 fingerprint on
-- every member costs 165 bytes at the longest live path (81% of budget) and re-stores 71.6 KiB of
-- identical hash. Interning gives 104 bytes worst case.
--
-- ON DELETE CASCADE is the PRIMARY safety control, not tidiness. Without AUTOINCREMENT, SQLite
-- reuses a deleted rowid when the deleted row held the largest one — which is exactly what LRU
-- eviction does when the cap binds. Reproduced with foreign_keys=OFF: evict the max-rowid set, its
-- members are stranded, and the next caller is allocated the REUSED id and reads them. The eviction
-- code ALSO deletes members explicitly, because foreign_keys is per-connection runtime state and
-- correctness must not depend on a PRAGMA.
CREATE TABLE IF NOT EXISTS acl_path_members (
  set_id INTEGER NOT NULL REFERENCES acl_path_sets(set_id) ON DELETE CASCADE,
  path   TEXT    NOT NULL,
  PRIMARY KEY (set_id, path)
) WITHOUT ROWID;
