---
type: Fixed
---
- **Treat bridge paths that normalize to the vault root as missing attribution.** Restricted callers now fail closed on root-only bridge rows, while real paths in the same row remain authoritative.
