-- 20260728_001_jobs_owner.sql
-- THE-583: ownership columns on `jobs`, so the durable queue can back the MCP Tasks extension.
--
-- The 2026-07-28 revision moved Tasks out of the core protocol into an extension: a long-running
-- call returns a task handle and the client polls `tasks/get` / drives `tasks/cancel`. The queue
-- (THE-517) is the right substrate, but it could not be exposed as-is for two reasons, and the
-- second is the important one:
--
--   1. There was no vault or caller column, so `tasks/get` against it would let ANY authenticated
--      caller read ANY job by id — including `payload` and `last_error`, which carry vault paths
--      and error text. In a multi-vault deployment that is a cross-vault read, the class THE-563 /
--      THE-564 exist to prevent.
--
--   2. Every job in the table today is INTERNAL maintenance work — reconcile, contradiction,
--      synthesis, audit, index-coordinator writes. No MCP caller asked for any of it. Surfacing
--      those as "your tasks" would be wrong even with perfect isolation: they are not the caller's
--      tasks, and their existence and failure text are server-operational detail.
--
-- Both columns are NULLABLE and NULL is the meaningful default: a job with no owner is internal and
-- is NEVER visible over MCP. That makes the safe case the one you get by doing nothing — every
-- existing row, and every existing `enqueue` call site, stays invisible without being touched.
-- Visibility is opt-in at enqueue time, not opt-out at read time.

ALTER TABLE jobs ADD COLUMN vault_id TEXT;
ALTER TABLE jobs ADD COLUMN caller TEXT;

-- Partial index: only owned rows are ever queried this way, and internal jobs (the overwhelming
-- majority, and unbounded in number) are kept out of the index entirely.
CREATE INDEX IF NOT EXISTS idx_jobs_owner
  ON jobs(vault_id, caller, created_at DESC)
  WHERE vault_id IS NOT NULL;
