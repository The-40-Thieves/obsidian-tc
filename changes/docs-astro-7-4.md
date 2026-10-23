---
type: Security
---
- **Docs site dependencies bumped to clear a `http-cache-semantics` advisory.** `astro` 7.4.2 and `@astrojs/starlight` 0.42.6 resolve `http-cache-semantics` 4.3.0, which fixes GHSA-ch52-4w7c-c8xp. The docs-workspace ignore for that advisory is removed. The docs site build is unchanged for readers.
