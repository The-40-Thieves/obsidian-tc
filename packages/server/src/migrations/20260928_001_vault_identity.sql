-- 20260928_001_vault_identity.sql
-- Stable vault identity: `chunks.vault_id` (and every other vault_id-keyed table) keys on the
-- config's `vaults[].id`, a MUTABLE string with no path identity behind it. Two consequences fixed
-- by this table plus the boot-time resolver it backs (vault/identity.ts):
--
--   1. Renaming a vault's `id` in config orphans every row that id's index rows were written
--      under — the old id's chunks/embeddings/notes/etc. are unreachable, and the sticky-provider
--      resolver (embeddings/sticky-provider.ts, GH #995) can only flag this as
--      "ambiguous-orphaned-index", never resolve it, because it has no way to tell "this id was
--      renamed" apart from "a different vault reused this cache directory".
--   2. The zero-config path always assigns id "main" with a shared default cacheDir, so two
--      DIFFERENT vaults opened that way silently share rows under one id.
--
-- This table records each vault's canonical root path (realpath, case-normalized on win32/darwin
-- — see vault/identity.ts's `normalizeRealpathForIdentity`) the first time obsidian-tc sees it, so
-- a later boot can tell "same path, new id" (a rename — re-key every vault_id-keyed row from the
-- old id to the new one) apart from "same id, different path" (two vaults colliding on one id,
-- refused rather than silently sharing/overwriting rows — see vault/identity.ts's own header for
-- the isolate-vs-namespace tradeoff and why isolate was chosen).
--
-- `root_realpath` is UNIQUE: at most one vault_id may claim a given canonical root at a time. This
-- is what makes "same path, different id" a well-defined single row to compare against, and it is
-- exactly the invariant the rename case relies on — a path can move to a NEW id (rename, replacing
-- the row) but never be claimed by two ids simultaneously.
--
-- `root_canonical` (fix round, cross-vendor review Medium 5): 0 when `root_realpath` is only the
-- LEXICAL fallback (`path.resolve`, no realpath) because realpath() failed the boot that recorded
-- it — a missing/not-yet-created directory or a transient lock, vault/registry.ts's own
-- `canonicalizeVaultRootWithStatus`. A fallback value is never authoritative: a LATER boot whose
-- realpath succeeds can legitimately produce a DIFFERENT string for the exact same vault (8.3 ->
-- long name, `/var` -> `/private/var`, `\\?\C:\...` vs `C:\...`, a subst/mapped drive), and without
-- this flag that boot would read as "same id, different path" and refuse the vault against itself.
-- 1 (the default) means `root_realpath` came from a genuine realpath() and is safe to compare
-- as-is; a provisional (0) row is upgraded in place (same id, `root_realpath` and `root_canonical`
-- updated, no re-key) the first time a boot resolves it canonically — see
-- `resolveVaultIdentity` in vault/identity.ts.
CREATE TABLE IF NOT EXISTS vault_identity (
  vault_id       TEXT PRIMARY KEY,
  root_realpath  TEXT NOT NULL,
  root_canonical INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_identity_realpath ON vault_identity(root_realpath);
