---
type: Fixed
---
- **A `limit` sent to a `k` tool, or `k` sent to a `limit` tool, now says which name to use.** The validation error now carries a `did you mean "k" for "limit"?` hint (or the reverse) instead of a bare rejection; a non-numeric string under `k` still gets the edit-distance hint, so `k: "status"` keeps pointing at `key`. Nothing is renamed or accepted under a second name, and no advertised schema changes; the hint is derived from each tool's own input keys.
