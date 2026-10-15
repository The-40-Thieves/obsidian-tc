---
type: Fixed
tool-description-change: knowledge_challenge, reflect
---
- **`knowledge_challenge` and `reflect` (mode `challenge`) no longer return silent zero evidence.** The decision filter now runs over a 200-chunk readable recall pool before the evidence cut, instead of over a fixed top-30, so decision notes are no longer lost when they are a small share of a vault's chunks. Both tools return a `coverage` object (`recalled`, `decision_matched`, `filtered_out`, `kept`, `dropped`, `truncated`, `low_coverage`) counted over the notes the caller may read. Cited `evidence_paths` are checked against the evidence the judge was shown: unseen paths are listed in `coverage.unresolved_evidence_paths` and items with no shown path are dropped. `reflect` with `mode: "challenge"` and `persist: true` now returns a validation error instead of ignoring `persist`.
