-- 20260711_002_agent_episodes.sql
-- THE-228: agent_episodes — the auto-capture work-memory log (THE-227 epic), in the SEPARATE
-- experiential store per the membrane. Capture-everything on the ACTION axis: every dispatch
-- outcome lands as one append-only row via the registry onEpisode hook. The CONTENT axis
-- (raw args) is config-gated (experiential.captureContent, default OFF until THE-238's
-- poisoning defense lands); when on, args are secret-scanned + size-capped before storage.
--
-- Write-on controls (2026-06-26 gate decision):
--   * `blocked`      retrieval-time tombstone (control 1); `work_forget` surfaces it (THE-229).
--   * `eligibility`  evaluator selective-addition stamp (control 2) — rows are born 'pending'
--                    and become retrievable only when the sleep-time evaluator marks them
--                    'eligible'; the log stays complete while retrieval-USE is gated.
--   * valid_from / valid_until  bi-temporal invalidation honored by readers (control 3).
--   * `caller` / `session_id`   self-carried attribution at write (constraint 4; THE-160 is
--                    explicitly NOT a dependency).
CREATE TABLE agent_episodes (
  id            TEXT PRIMARY KEY,            -- ep_<hex>
  ts            INTEGER NOT NULL,            -- ms epoch, capture time
  vault_id      TEXT,
  session_id    TEXT,                        -- active workspace session, else NULL
  caller        TEXT,                        -- principal (attribution at write)
  channel       TEXT NOT NULL,               -- write channel: 'dispatch' (v1); 'ambient'/'import' later
  episode_type  TEXT NOT NULL,               -- 'tool_call' (v1)
  tool          TEXT,
  status        TEXT NOT NULL,               -- ok | error | skipped (dispatch outcome)
  error_code    TEXT,
  duration_ms   INTEGER,
  result_size   INTEGER,
  args_hash     TEXT,
  args_json     TEXT,                        -- content axis: NULL unless captureContent; scanned + capped
  secret_scan   TEXT,                        -- 'off' | 'clean' | 'redacted:<n>'
  summary       TEXT,                        -- gist, filled at consolidation (THE-222); NULL at capture
  tags          TEXT,                        -- JSON array
  outcome       INTEGER,                     -- -1 | 0 | +1 (parity with chunk_retrievals outcome axis)
  eligibility   TEXT NOT NULL DEFAULT 'pending',  -- pending | eligible | ineligible
  trust         REAL,                        -- provenance trust (THE-238 channel policy)
  blocked       INTEGER NOT NULL DEFAULT 0,  -- tombstone
  valid_from    INTEGER,
  valid_until   INTEGER,
  prev_id       TEXT                         -- previous episode by same caller (temporal chain)
);

CREATE INDEX idx_agent_episodes_ts       ON agent_episodes(ts DESC);
CREATE INDEX idx_agent_episodes_session  ON agent_episodes(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_agent_episodes_caller   ON agent_episodes(caller, ts DESC);
CREATE INDEX idx_agent_episodes_retrieve ON agent_episodes(eligibility, blocked, ts DESC);
