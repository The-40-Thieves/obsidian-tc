---
type: Fixed
tool-description-change: knowledge_challenge, reflect
---
- **`knowledge_challenge` and `reflect` (mode `challenge`) no longer return silent zero evidence.** The decision filter runs over the normal 30 readable results first and expands once, to at most 90, only when decision evidence is underfilled. Both tools return a `coverage` object (`recalled`, `decision_matched`, `filtered_out`, `kept`, `dropped`, `truncated`, `low_coverage`) counted over the notes the caller may read. Cited `evidence_paths` are checked against every evidence or contradiction path shown to the judge: unseen paths are listed in `coverage.unresolved_evidence_paths`, unsupported items are dropped, and an objection verdict (`reconsider` or `do_not_proceed`) left with no supported citation, stripped or never given, is downgraded to `reconsider` with a neutral summary. `reflect` with `mode: "challenge"` and `persist: true` now returns a validation error instead of ignoring `persist`.
