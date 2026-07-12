-- 20260712_003_forget_log.sql
-- THE-239: the hash-chained forget audit log. Every dependency-aware deletion (episode or
-- note) appends one row whose hash covers the previous row's hash + this row's fields —
-- tampering with or removing any entry breaks the chain (verifyForgetLog walks it). This is
-- the "tombstone + audit" half of the GDPR / EU AI Act policy tension: the log records THAT
-- something was forgotten and what cascaded, never the forgotten content itself.
CREATE TABLE forget_log (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('episode', 'note')),
  target    TEXT NOT NULL,             -- episode id or vault-relative note path
  mode      TEXT NOT NULL CHECK (mode IN ('tombstone', 'erase')),
  details   TEXT,                      -- JSON cascade summary (counts + report-only findings)
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL
);
