-- 20261002_001_wiki_judge.sql
-- The LLM judge behind find_existing_page / lint_wiki: a verdict cache and a daily call counter.
--
-- wiki_judge_verdicts caches one verdict per judged pair so a repeat costs nothing. The key is the
-- CONTENT of both sides plus the model that ruled, so it invalidates itself: an edited note hashes
-- differently and is judged again, and a verdict from before the gateway `judge` alias was
-- repointed is never served as the new model's. `kind` says what the subject side is:
--   'topic'  find_existing_page: subject_hash is the hash of the normalised topic string,
--            candidate_hash the hash of the candidate note's raw text;
--   'pair'   lint_wiki: both are note hashes, stored in sorted order (the verdict is symmetric).
-- `model` is the RESOLVED provider/model the gateway reported, never the alias. No note text is
-- stored, only hashes and the judge's short rationale. A cache, not an audit store: it is safe to
-- delete (`rm cache.db*`), the next call just re-judges.
--
-- wiki_judge_usage counts gateway judge calls per UTC day (a failed or timed-out call counts: it
-- cost a request) so wikiJudge.maxCallsPerDay survives a restart and doctor can report today's use.
CREATE TABLE IF NOT EXISTS wiki_judge_verdicts (
  kind           TEXT    NOT NULL CHECK (kind IN ('topic', 'pair')),
  subject_hash   TEXT    NOT NULL,
  candidate_hash TEXT    NOT NULL,
  model          TEXT    NOT NULL,
  verdict        TEXT    NOT NULL CHECK (verdict IN ('same_topic', 'overlapping', 'different')),
  rationale      TEXT    NOT NULL,
  judged_at      INTEGER NOT NULL,           -- epoch ms
  PRIMARY KEY (kind, subject_hash, candidate_hash, model)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_wiki_judge_verdicts_judged_at ON wiki_judge_verdicts (judged_at);

CREATE TABLE IF NOT EXISTS wiki_judge_usage (
  day      TEXT    PRIMARY KEY,              -- UTC date, YYYY-MM-DD
  calls    INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0        -- of `calls`: timeouts, gateway errors, unusable replies
) WITHOUT ROWID;
