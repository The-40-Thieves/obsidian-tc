---
type: Security
---
- **Harden release-sensitive file, search, cache, and concurrency paths.** Eval vault setup now rejects symlinks; live Excluded-files rules fail closed across indexing and graph retrieval; dedup reconciliation cannot inherit an excluded vector owner; unrestricted graph calls receive derived defaults; cache replay sizing is non-vacuous; Templater provenance stamping preserves concurrent edits; active-file races remain schema-valid; and rerun cleanup preserves live sandboxes. The documented sequential memory-observation identifier remains compatibility-stable with its activity-metadata residual made explicit.
