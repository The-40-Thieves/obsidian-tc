---
type: Fixed
---
- **A SQLite open that fails on its first pragma no longer leaves the connection open.** Opening a file that is not a database (a corrupt `cache.db`) constructed the connection, then threw from the first pragma without closing it, in all three adapters (better-sqlite3, node:sqlite, bun:sqlite). The handle lived until garbage collection, and on Windows that made the file and its directory undeletable by a caller that had already handled the failure. The adapters now close the connection and rethrow the original error.
