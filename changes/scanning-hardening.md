---
type: Security
---
- **Harden benchmark caches and release tooling.** The recycle benchmark now creates a private, unique OS-temp cache unless `MEASURE_CACHE` is set. Native publishing invokes the lockfile-installed CLI directly, with no registry fallback.
