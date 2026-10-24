---
type: Changed
tool-description-change: audit_provenance
---
- **`audit_provenance` counts evidence in the note body.** A note with no `sources` field but a URL, a footnote definition or a Sources/References section with a list or link is reported as cited in body only (`body_only`, `body_only_count`) instead of missing. Citations inside code are not counted. `lint_wiki`'s `missing_sources` check uses the same scan, so it no longer proposes those notes.
- **`audit_provenance` takes `types`.** Only notes whose frontmatter `type` matches are claim-bearing; the rest are counted in `skipped_by_type`. Without `types` the scan covers every readable note, as before.
