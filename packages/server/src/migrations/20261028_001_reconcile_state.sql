-- 20261028_001_reconcile_state.sql
-- GH #995 follow-up: the leader's reconcile outcome, persisted so a FOLLOWER process can report it.
-- Only the vault-lock leader runs reconciles (runtime/vault-lock.ts gateReconcileByLeader), so a
-- follower's in-memory indexHealth never leaves "pending" and its server_health / get_index_status
-- said so forever while search (which reads the leader's cache.db) worked.
--
-- Single row, per cache.db (the SAME granularity as index_leader_epoch and the leader lock). Written
-- by the leader once per completed pass (runtime/reconcile-state.ts, from applyReconcileOutcome), and
-- when a notes pass first completes (notes_ready only, monotonic). That notes-only write also comes
-- from a runtime add_vault, which runs in whichever process receives the call, follower or leader.
-- Read by a follower's health tools.
--
-- epoch is the index_leader_epoch value the writing pass ran under. A reader treats a row whose epoch
-- is not the CURRENT one as pending, so a predecessor's last outcome never shows as the current
-- leader's; the runner also skips the write once a successor has promoted (plane-wiring.ts).
--
-- reconcile_errors is a JSON array of { vault, error } — the same two fields server_health's
-- detail.reconcile_errors advertises. The migration does not seed a row: "no row" means pending.
CREATE TABLE IF NOT EXISTS reconcile_state (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  state            TEXT    NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ok', 'degraded')),
  reconcile_at     INTEGER,
  reconcile_errors TEXT    NOT NULL DEFAULT '[]',
  notes_ready      INTEGER NOT NULL DEFAULT 0 CHECK (notes_ready IN (0, 1)),
  epoch            INTEGER NOT NULL DEFAULT 0
);
