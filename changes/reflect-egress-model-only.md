---
type: Fixed
---
- **`egress.excludePaths` withholds text from models only.** Reflect now returns every top-k source in `sources` and the retrieval log at its original rank in every mode, egress-excluded ones included: ids, paths and scores are not egress, and excluded text still never reaches a model. In degraded mode (no gateway) excluded hits are no longer dropped silently. `excluded_count` means one thing in every mode: the number of returned top-k sources whose content was withheld from the model (degraded mode counts the hits that would have been withheld). Persisted reflection provenance lists exactly the chunks the model was shown.
