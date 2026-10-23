---
type: Fixed
---
- **An empty `cacheDir` no longer opens a lock file in the working directory.** The indexing leader lock resolved `vault-lock.db` against the process cwd when `cacheDir` was `""`, leaking a stray file and risking collisions between unrelated runs. The election now refuses an empty `cacheDir` with a clear error naming it.
