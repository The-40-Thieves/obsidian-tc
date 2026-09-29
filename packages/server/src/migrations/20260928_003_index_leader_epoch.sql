-- 20260928_003_index_leader_epoch.sql
-- GH #995 follow-up: the demotion residual left by the leader-lock PR. A leader that demotes (lock
-- lost / lock file replaced) while an ONNX sub-batch is mid-call can still COMMIT after a successor
-- has already promoted and started its own reconcile — the per-note note_write_fence generation
-- (20260928_002) only catches this when the successor has ALSO re-planned the same note; a note
-- whose content the successor's reconcile has not yet reached (or replans to an identical, no-op
-- plan) never bumps its fence, so the demoted leader's stale commit would otherwise still land.
--
-- Single row, per cache.db (the SAME granularity vault-lock.ts's lock already uses — "per-vault"
-- there really means "per cacheDir", i.e. one lock and one epoch per server process's leader
-- election, not per named vault within it). Bumped once per PROMOTION
-- (runtime/server-runtime.ts wires leaderElection.onPromote to search/indexing/leader-epoch.ts's
-- bumpLeaderEpoch), read back inside indexVault's batch-commit transaction
-- (search/indexing/index-vault.ts) and compared against the epoch the RECONCILE RUN started with —
-- a mismatch means a successor has since promoted, and the whole in-flight batch is dropped rather
-- than committed. Deliberately NOT consulted by index-on-write (reindexHook/deindexHook) or the
-- index_vault TOOL call: those are explicit, role-agnostic writes the leader-lock design already
-- keeps reachable on every role, and gating them on leadership would be the exact over-blocking the
-- design note warns against.
CREATE TABLE IF NOT EXISTS index_leader_epoch (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  epoch       INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0
);
