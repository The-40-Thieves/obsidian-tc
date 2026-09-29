-- 20260928_002_note_write_fence.sql
-- GH #995 follow-up: commit-time freshness fencing for index writes. The per-vault leader lock
-- (runtime/vault-lock.ts) stops FOLLOWERS from running boot/periodic reconcile and watcher-driven
-- writes, but explicit writers stay ungated on every role: reindexHook/deindexHook (index-on-write
-- of a note's own write_note/append_note/patch_note) and the index_vault tool. Index coordinators
-- (search/index-coordinator.ts) are PROCESS-LOCAL, so two processes racing the SAME (vault, path)
-- across the SAME cache.db were never serialized against each other — indexNote embeds BEFORE
-- commit with no freshness check, so an older delayed write could commit after a newer one (stale
-- overwrite), or after a deindex (resurrecting deleted search state).
--
-- One row per (vault_id, path), monotonically bumped on every COMMITTED write or delete for that
-- path (search/indexing/write-fence.ts). A writer captures `generation` when its plan is computed
-- (planNoteWrites/computeNotePlan, alongside the existing chunk-row snapshot) and re-presents it at
-- COMMIT time, inside the same write transaction persist-note-plan.ts's applyNoteWrites already
-- owns; a mismatch means a fresher commit landed in the gap, and the stale write is DROPPED
-- (counted, logged at debug) rather than applied. deindexNote bumps unconditionally, even when it
-- deletes nothing (a path never yet indexed) — a delete is always the fresher signal, so a plan
-- read before it always fails the re-check after. No separate "tombstoned" flag is needed: any
-- reader presenting a generation older than the current one is rejected regardless of whether the
-- bump that moved it was a write or a delete, which is what makes a delete a tombstone here.
CREATE TABLE IF NOT EXISTS note_write_fence (
  vault_id    TEXT NOT NULL,
  path        TEXT NOT NULL,
  generation  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (vault_id, path)
);
