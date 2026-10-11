---
type: Added
---
- **Experimental, opt-in libSQL database adapter and `storage.sync` config (multi-device index sync spike).** A new `libsql` adapter (the optional `libsql` package, SQLite 3.45) can open the index database as an embedded replica of a self-hosted `sqld` or a Turso database, with `storage.sync.url` and `storage.sync.authTokenEnv` naming the environment variable that holds the token. Off by default: with `storage.sync` unset nothing changes and `libsql` is never loaded. The server does not read `storage.sync` yet, so this release adds the adapter, the config shape, a compile-time embed for standalone binaries (`scripts/build-binary.ts --with-libsql`) and the tests, not a working sync setup.
