---
type: Added
tool-description-change: record_retrieval_feedback
---
- **`record_retrieval_feedback` accepts a batch of verdicts.** Send `verdicts: [{chunk_id, feedback}, ...]` (1 to 50 items) to stamp several retrieved chunks in one call, instead of one call per chunk. Every item gets the same ownership and session-scope checks as the single form and reports its own `updated` (plus a `reason` when nothing was written) under `results`; the batch is applied in one transaction. The single `chunk_id` + `feedback` form is unchanged. Send one form or the other, never both.
