-- THE-374: point-in-time note snapshots for restore_note. Content-addressed blob store
-- (SHA-256 dedup per vault) + a per-note snapshot ledger. Auto-captured on destructive
-- writes when config.snapshots.enabled; read back / rolled back via the M1 snapshot tools.
CREATE TABLE IF NOT EXISTS snapshot_blobs (
  vault_id TEXT NOT NULL,
  hash     TEXT NOT NULL,           -- contentHash(content)
  content  TEXT NOT NULL,           -- full note bytes at capture time
  size     INTEGER NOT NULL,
  PRIMARY KEY (vault_id, hash)
);
CREATE TABLE IF NOT EXISTS note_snapshots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_id   TEXT NOT NULL,
  path       TEXT NOT NULL,
  hash       TEXT NOT NULL,         -- -> snapshot_blobs(vault_id, hash)
  op         TEXT NOT NULL,         -- capturing op: write_note|append_note|patch_note|delete_note|move_note|copy_note|update_frontmatter|restore_note|manual
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_note_snapshots_path ON note_snapshots(vault_id, path, id);
