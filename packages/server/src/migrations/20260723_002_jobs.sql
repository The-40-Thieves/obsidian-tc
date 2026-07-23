-- 20260723_002_jobs.sql
-- THE-517: a durable job-queue record. Replaces the split in-memory/DB retry state that THE-462
-- left in `job_schedule` (a per-JOB-NAME row for the four periodic sweeps) with a per-JOB-INSTANCE
-- record for one-shot/queued work: attempt count, backoff, and lease all live in this table and
-- ONLY here — a crashed process has nothing in memory to disagree with it.
--
-- state machine: queued -> running -> {complete | retrying | failed}; retrying -> running (once
-- next_attempt_at is due); running -> running (lease reclaimed by a new owner past
-- lease_expires_at, which is how crash recovery works — see job-queue.ts claim()).
--
-- class is the bounded-concurrency bucket (defaults to type; several types can share a class).
-- idempotency_key is UNIQUE (NULLs are distinct in SQLite, so non-deduped jobs are unaffected);
-- enqueue() upserts against it so the same key enqueued twice yields the same row.
CREATE TABLE IF NOT EXISTS jobs (
  id                TEXT PRIMARY KEY,
  type              TEXT NOT NULL,
  class             TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'queued'
                      CHECK (state IN ('queued', 'running', 'retrying', 'complete', 'failed')),
  attempt           INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 5,
  next_attempt_at   INTEGER,
  lease_owner       TEXT,
  lease_expires_at  INTEGER,
  cancel_requested  INTEGER NOT NULL DEFAULT 0,
  checkpoint        TEXT,
  payload           TEXT,
  idempotency_key   TEXT,
  last_error        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency_key ON jobs (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Claim's due-scan filters on state and orders by due time; this covers both branches
-- (queued jobs have next_attempt_at NULL and sort by created_at via COALESCE at query time).
CREATE INDEX IF NOT EXISTS jobs_claim_scan ON jobs (state, class, next_attempt_at);
