-- 20260803_002_goals.sql
-- THE-633: stated goals — what the user is TRYING TO DO, as a first-class plane object.
--
-- The plane modelled preferences ("you tend to X") and had no notion of intent ("you intend to X").
-- Those are not the same shape and a goal cannot be a preference row with a different key: a
-- preference moves by WEIGHT (add/strengthen/weaken/retract) and never resolves; a goal moves by
-- TERMINAL STATE (completed/abandoned/expired) and does. A shared `op` CHECK over both vocabularies
-- would be the union of two disjoint sets, which is not a constraint at all. Hence its own table.
--
-- MEMBRANE DECISION (2026-08-03): goals live HERE, in experiential.db, with the trust boundary
-- enforced on the WRITE PATH rather than by the file. The store's charter admits them — it holds
-- "NON-RECONSTRUCTABLE keep-state", and a stated goal is exactly that, since it cannot be recomputed
-- from the vault. And the membrane's actual mechanism is a FILE boundary preventing cross-store
-- foreign keys ("object_id / chunk_id reference chunk ids BY VALUE — this is the membrane"), not a
-- trust label attached to a store: a goals table here still cannot FK into an authored atom, so the
-- property the membrane enforces is unchanged. Current practice in the field separates by write
-- AUTHORITY, not by storage (Letta's read_only blocks, Mem0's infer:false verbatim path, OWASP
-- ASI06's write-time admission + provenance binding). Precedent, too: preference_profile is
-- user-shaped data and already lives here.
--
-- THE FOUR THINGS THE DECISION REQUIRES, and where each is enforced:
--
--   1. vault_id FROM THE FIRST MIGRATION. Not boilerplate — it is the one instruction that
--      contradicts the nearest example in the codebase. preference_profile shipped without it and
--      needed a rebuild (THE-710, 20260803_001) landed immediately before this file. Getting it
--      right here is the whole reason that rebuild went first.
--   2. `source` CHECK-pinned to stated provenance, so an INFERRED write is a CONSTRAINT VIOLATION
--      rather than a convention someone can quietly break. Written as an IN-list with one member so
--      widening it later is a deliberate migration, not an edit.
--   3. Only the explicit set_goal / close_goal tools write this table. reflect.ts must never gain a
--      goals write path — enforced by a grep gate in test/goals.test.ts, the same technique
--      graph-analytics.test.ts uses to prove analytics never reaches ranking.
--   4. Authority monotonicity: no low-confidence path may mutate a goal row. There is no
--      strengthen/weaken here at all; the only transitions are open -> terminal.
--
-- GOALS EXPIRE, and expiry is a STATE not a delete. A goals table with no expiry silently becomes a
-- list of things the user gave up on, biasing every downstream consumer toward stale intent. An
-- overdue goal is marked 'expired' and kept, so the history survives and "abandoned on purpose" and
-- "ran out of time" stay distinguishable.

CREATE TABLE goals (
  id          TEXT PRIMARY KEY,
  vault_id    TEXT NOT NULL,
  text        TEXT NOT NULL,
  -- open is the only non-terminal state. completed/abandoned are user verdicts; expired is the
  -- sweep's, and is deliberately distinct from abandoned.
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'completed', 'abandoned', 'expired')),
  -- Constraint 2. One member today; widening it is a migration, which is the point.
  source      TEXT NOT NULL CHECK (source IN ('stated')),
  created_at  INTEGER NOT NULL,
  target_date INTEGER,
  closed_at   INTEGER,
  -- A terminal row without a closed_at, or an open row with one, is incoherent state. Enforced here
  -- rather than in the writer so it holds for anything that ever touches this table.
  CHECK ((status = 'open') = (closed_at IS NULL))
);

-- The read path is always "this vault's goals, usually the open ones".
CREATE INDEX idx_goals_vault_status ON goals(vault_id, status);
-- The expiry sweep's access pattern: open goals with a deadline, oldest first.
CREATE INDEX idx_goals_due ON goals(target_date) WHERE target_date IS NOT NULL;
