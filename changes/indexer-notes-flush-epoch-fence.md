---
type: Fixed
---
- **A demoted indexer no longer upserts note bodies or search rows after a successor takes leadership.** The notes pass now re-checks the leader epoch inside its write transaction and drops the whole batch when a successor has promoted, so the stale note body stops being readable and searchable until the successor re-indexes it.
