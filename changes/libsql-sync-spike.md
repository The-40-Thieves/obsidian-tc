---
type: Added
---
- **Experimental libSQL adapter and `storage.sync` config (off by default).** A fourth database adapter over the `libsql` package (SQLite 3.45) can run the full migration chain, both FTS5 tables and sqlite-vec, and can open a file as an embedded replica of a libSQL server (Turso Cloud or self-hosted sqld) with writes forwarded to the server. The new `storage.sync` block (`url`, `authTokenEnv`, `syncIntervalMs`) is validated but not yet read by the server boot path, so nothing changes unless you call the adapter yourself. The token is only ever the name of an environment variable.
