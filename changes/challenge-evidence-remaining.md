---
type: Fixed
---
- **Egress-excluded chunks no longer take up challenge evidence slots.** Chunks whose text is withheld from models by `egress.excludePaths` are now removed before the challenge evidence is selected, so they no longer count against the evidence cap or the per-note limit, and a recall page that is mostly withheld now expands to find readable decision chunks. Withheld chunks are reported in `coverage.dropped.egress`, and `knowledge_challenge`'s `excluded_count` includes them.
- **A judge call that fails still leaves its retrieval in the retrieval log.** `reflect` (challenge mode) and `knowledge_challenge` now log the evidence before the judge runs, so the log is written once whether or not the judge call succeeds.
