---
type: Fixed
config-schema-change: cacheDir
---
- **An empty `cacheDir` is now refused instead of writing caches into the working directory.** With `cacheDir: ""`, the index, auth registry and indexing leader lock (`vault-lock.db`) all resolved against the process's current directory, leaking files there and letting unrelated runs collide. Config load now rejects an empty `cacheDir` with an error naming it, and the leader election refuses an empty or blank one as a second guard for programmatic callers. A config that set `cacheDir: ""` must name a directory (or drop the key to use the default `.obsidian-tc`).
