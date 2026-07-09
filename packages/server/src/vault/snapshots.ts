// THE-374: point-in-time snapshot store backing restore_note. Content-addressed (SHA-256
// dedup per vault) so identical prior states share one blob; a per-note ledger records each
// capture. captureSnapshot() is called by the M1 write handlers BEFORE they mutate, when
// config.snapshots.enabled, so a mistaken write is recoverable. Retention keeps the newest N
// per note and GCs blobs no longer referenced by any surviving snapshot.
import type { Database } from "../db/types";
import { contentHash } from "./paths";

export interface SnapshotCaptureConfig {
  enabled: boolean;
  retention: number;
}

export interface SnapshotRow {
  id: number;
  content_hash: string;
  op: string;
  size: number;
  created_at: number;
}

export interface SnapshotContent {
  path: string;
  content: string;
  content_hash: string;
  op: string;
  created_at: number;
}

/** Capture `content` as a snapshot of (vaultId, path). No-ops when cfg is undefined/disabled.
 *  Dedups the blob, appends a ledger row, prunes to cfg.retention. Returns the new id or null. */
export function captureSnapshot(
  db: Database,
  cfg: SnapshotCaptureConfig | undefined,
  vaultId: string,
  path: string,
  content: string,
  op: string,
  now: () => number = Date.now,
): number | null {
  if (!cfg?.enabled) return null;
  const hash = contentHash(content);
  const size = Buffer.byteLength(content, "utf8");
  db.prepare(
    "INSERT OR IGNORE INTO snapshot_blobs (vault_id, hash, content, size) VALUES (?, ?, ?, ?)",
  ).run(vaultId, hash, content, size);
  const info = db
    .prepare(
      "INSERT INTO note_snapshots (vault_id, path, hash, op, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(vaultId, path, hash, op, now());
  pruneSnapshots(db, vaultId, path, cfg.retention);
  return Number(info.lastInsertRowid);
}

/** Keep only the newest `retention` snapshots of (vaultId, path); GC now-orphan blobs. */
function pruneSnapshots(db: Database, vaultId: string, path: string, retention: number): void {
  const ids = db
    .prepare("SELECT id FROM note_snapshots WHERE vault_id = ? AND path = ? ORDER BY id DESC")
    .all(vaultId, path) as Array<{ id: number }>;
  if (ids.length <= retention) return;
  const del = db.prepare("DELETE FROM note_snapshots WHERE id = ?");
  for (const r of ids.slice(retention)) del.run(r.id);
  db.prepare(
    "DELETE FROM snapshot_blobs WHERE vault_id = ? AND hash NOT IN (SELECT hash FROM note_snapshots WHERE vault_id = ?)",
  ).run(vaultId, vaultId);
}

/** Newest-first snapshot ledger for a note (joined to blob size). */
export function listSnapshots(
  db: Database,
  vaultId: string,
  path: string,
  limit: number,
): SnapshotRow[] {
  return db
    .prepare(
      "SELECT s.id AS id, s.hash AS content_hash, s.op AS op, s.created_at AS created_at, b.size AS size " +
        "FROM note_snapshots s JOIN snapshot_blobs b ON b.vault_id = s.vault_id AND b.hash = s.hash " +
        "WHERE s.vault_id = ? AND s.path = ? ORDER BY s.id DESC LIMIT ?",
    )
    .all(vaultId, path, limit) as SnapshotRow[];
}

/** Read one snapshot's full stored content by id (scoped to the vault). */
export function readSnapshot(
  db: Database,
  vaultId: string,
  snapshotId: number,
): SnapshotContent | null {
  const row = db
    .prepare(
      "SELECT s.path AS path, s.hash AS content_hash, s.op AS op, s.created_at AS created_at, b.content AS content " +
        "FROM note_snapshots s JOIN snapshot_blobs b ON b.vault_id = s.vault_id AND b.hash = s.hash " +
        "WHERE s.vault_id = ? AND s.id = ?",
    )
    .get(vaultId, snapshotId) as SnapshotContent | undefined;
  return row ?? null;
}
