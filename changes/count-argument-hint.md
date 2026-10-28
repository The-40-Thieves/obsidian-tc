---
type: Fixed
---
- **A `limit` sent to a `k` tool, or `k` sent to a `limit` tool, now says which name to use.** The validation error reads `did you mean "k"?` (or `"limit"`) instead of a bare rejection. Nothing is renamed or accepted under a second name, and no advertised schema changes; the hint is derived from each tool's own input keys.
