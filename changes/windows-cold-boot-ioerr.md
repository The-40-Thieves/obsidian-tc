---
type: Fixed
---
- **On Windows, several servers cold-booting on one cache directory could fail with `disk I/O
  error`.** When the processes race to convert a fresh database to WAL, a sibling that has already
  finished holds the main file memory-mapped, and Windows refuses SQLite's `SetEndOfFile` on it: the
  loser's `PRAGMA journal_mode = WAL` fails with `SQLITE_IOERR_TRUNCATE` (extended code 1546) and the
  server exited at boot. The pragma is a no-op once the sibling has converted the file, so the
  connection-pragma retry that already rides out `SQLITE_BUSY` now also retries this one code on
  Windows, within `db.busyTimeoutMs`; any other I/O error, and this one off Windows, still fails at
  once, now naming the pragma that raised it (`error.pragma`). Measured on windows-latest with
  `test/migrate-cold-boot-race.test.ts` at 600 iterations per chain: 15 of 14,400 iterations failed,
  every one at that pragma. (#1057)
