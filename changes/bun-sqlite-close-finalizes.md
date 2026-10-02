---
type: Fixed
---
- **Closing a bun:sqlite connection now releases its locks immediately.** The adapter's `close()` called `db.close()`, which is `sqlite3_close_v2`: with a prepared statement still outstanding (the adapter caches them for the life of the connection) the connection only became a zombie that kept its locks until the process ended. On Windows a terminating process's locks are released lazily, so servers booting against the same cache directory could fail with `database is locked` after a sibling shut down. `close()` now finalizes the statements first (`db.close(true)`), as the Node adapters already do.
