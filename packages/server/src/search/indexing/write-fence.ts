// GH #995 follow-up: commit-time freshness fencing for index writes. See
// db/migrations/20260928_002_note_write_fence.sql for the table and the two-process race it
// closes; persist-note-plan.ts's applyNoteWrites is the SINGLE call site that checks and bumps it,
// so every writer (indexNote's index-on-write path, indexVault's batched apply, and the index_vault
// tool, which both funnel through applyNoteWrites) is fenced the same way with no per-caller logic.
import { tableExists } from "../../db/introspect";
import { cachedPrepare, type Database } from "../../db/types";

// Mirrors hasBodyShaColumn/hasEmbeddingExcludedColumn (note-plan.ts): a pre-migration cache.db or a
// hand-built test chain lacks this table, and every consumer degrades to a no-op rather than
// throwing "no such table" — the exact pre-fencing behaviour.
const fenceTableCache = new WeakMap<Database, boolean>();

/** @internal exported for the memoization test; production callers use it directly. */
export function hasNoteWriteFence(db: Database): boolean {
  const cached = fenceTableCache.get(db);
  if (cached !== undefined) return cached;
  const ok = tableExists(db, "note_write_fence");
  fenceTableCache.set(db, ok);
  return ok;
}

/** The generation a note's path is currently fenced at (0 when never bumped, or on a pre-migration
 *  db). Call this at PLAN time — the SAME moment a plan's `existing` chunk-row snapshot is read
 *  (note-plan.ts's computeNotePlan) — so the plan carries the baseline its eventual commit must
 *  still match. */
export function readFenceGeneration(db: Database, vaultId: string, path: string): number {
  if (!hasNoteWriteFence(db)) return 0;
  const row = cachedPrepare(
    db,
    "SELECT generation FROM note_write_fence WHERE vault_id = ? AND path = ?",
  ).get(vaultId, path) as { generation: number } | undefined;
  return row?.generation ?? 0;
}

// THE-501-style bulk preload: one query for the whole vault's fence state, so a full reconcile
// plans every note from memory instead of a per-note query (see preloadChunkState, note-plan.ts,
// the same pattern this mirrors). Read-only, mirrors preloadChunkState's shape.
export function preloadFenceGenerations(db: Database, vaultId: string): Map<string, number> {
  if (!hasNoteWriteFence(db)) return new Map();
  const rows = db
    .prepare("SELECT path, generation FROM note_write_fence WHERE vault_id = ?")
    .all(vaultId) as Array<{ path: string; generation: number }>;
  return new Map(rows.map((r) => [r.path, r.generation]));
}

/**
 * Re-check a plan's fence generation and, if it still matches, bump it — ATOMICALLY, inside the
 * caller's WRITE TRANSACTION (persist-note-plan.ts's applyNoteWrites is the only production
 * caller). Returns `{ ok: false }` when `expectedGeneration` no longer matches the current value —
 * a fresher commit (a write OR a deindex tombstone, see bumpFenceUnconditional) landed in the gap
 * between this plan's read and its apply, and the caller must DROP this write rather than apply it.
 * A pre-migration db (no table) always returns `{ ok: true, generation: 0 }` — the exact
 * pre-fencing behaviour, never a "no such table" throw.
 */
export function commitFence(
  db: Database,
  vaultId: string,
  path: string,
  expectedGeneration: number,
  now: number,
): { ok: boolean; generation: number } {
  if (!hasNoteWriteFence(db)) return { ok: true, generation: 0 };
  const current = readFenceGeneration(db, vaultId, path);
  if (current !== expectedGeneration) return { ok: false, generation: current };
  const next = current + 1;
  cachedPrepare(
    db,
    "INSERT INTO note_write_fence (vault_id, path, generation, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(vault_id, path) DO UPDATE SET generation = excluded.generation, updated_at = excluded.updated_at",
  ).run(vaultId, path, next, now);
  return { ok: true, generation: next };
}

/**
 * Unconditionally bump a path's fence generation — deindexNote's tombstone (index-note.ts). A
 * delete is always the fresher signal, so it never checks the current value first: it bumps even
 * when nothing existed to delete (a path never yet indexed), so a write PLANNED before this delete
 * — which captured the pre-delete generation — always fails commitFence's re-check afterward,
 * however the race lands. No-op (returns 0) on a pre-migration db.
 */
export function bumpFenceUnconditional(
  db: Database,
  vaultId: string,
  path: string,
  now: number,
): number {
  if (!hasNoteWriteFence(db)) return 0;
  const current = readFenceGeneration(db, vaultId, path);
  const next = current + 1;
  cachedPrepare(
    db,
    "INSERT INTO note_write_fence (vault_id, path, generation, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(vault_id, path) DO UPDATE SET generation = excluded.generation, updated_at = excluded.updated_at",
  ).run(vaultId, path, next, now);
  return next;
}
