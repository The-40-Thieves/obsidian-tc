---
type: Fixed
---
- **Egress-excluded chunks no longer take up challenge evidence slots.** Chunks whose text is withheld from models by `egress.excludePaths` are now removed before the challenge evidence is selected, so they no longer count against the evidence cap or the per-note limit, and a recall page that is mostly withheld now expands to find readable decision chunks. Withheld chunks are reported in `coverage.dropped.egress`, and `knowledge_challenge`'s `excluded_count` includes them.
- **Challenge evidence the judge did not cite no longer earns retrieval-log activation credit.** `reflect` (challenge mode) and `knowledge_challenge` log only the evidence the judge cited, after the judge runs. A judge call that fails still logs the `reflect` top-k hits; `knowledge_challenge` logs nothing in that case, because the judge cited nothing.
