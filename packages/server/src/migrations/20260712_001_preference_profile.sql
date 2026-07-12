-- 20260712_001_preference_profile.sql
-- THE-222: the versioned preference profile — the LongMemEval preference-class mechanism,
-- updated ONLY by typed deltas (the ACE constraint folded from THE-232: add / strengthen /
-- weaken / retract with weight counters, never monolithic regeneration). preference_deltas is
-- the append-only audit of every applied delta; preference_profile is the current rollup the
-- readers consume (weight > 0). Lives in the experiential store with the rest of the derived
-- work-memory tier.
CREATE TABLE preference_profile (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  weight      REAL NOT NULL DEFAULT 1.0,   -- confidence counter: capped [0, 5]; 0 = retracted
  version     INTEGER NOT NULL,            -- monotonic batch version of the last touching delta
  updated_at  INTEGER NOT NULL,
  provenance  TEXT                         -- evidence gist from the extracting pass
);

CREATE TABLE preference_deltas (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  key      TEXT NOT NULL,
  op       TEXT NOT NULL CHECK (op IN ('add','strengthen','weaken','retract')),
  value    TEXT,
  evidence TEXT,
  version  INTEGER NOT NULL
);

CREATE INDEX idx_preference_deltas_version ON preference_deltas(version);
