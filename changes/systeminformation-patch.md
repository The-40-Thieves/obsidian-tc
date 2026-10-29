---
type: Security
---
- **Patch the hardware information dependency.** Raise `systeminformation` to 5.33.16, the patched version for GHSA-3f7j-7jwc-fxfj, and update the lockfile. Hardware discovery continues to use the existing CPU/graphics enrichment and fallback behavior.
