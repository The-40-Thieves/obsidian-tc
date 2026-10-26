---
type: Fixed
---
- **A bare `tools/list` no longer opens a workspace session in domain or flat mode.** With `sessions.autoOpen` on, those two modes opened one on every listing, as triad mode already did not. Domain-mode `tools/list` also now carries the same private one-minute cache hint as the other modes.
