---
type: Fixed
---
- **Several servers cold-booting on one cache directory could crash with `UNIQUE constraint failed:
  schema_migrations.version`.** Every stdio client spawns its own server, and on a fresh (or wiped)
  cache directory they all run the migration chain at once. The runner checked `schema_migrations`
  without a lock and then opened a plain `BEGIN`, so two processes could both decide a migration was
  pending: the loser either inserted a duplicate version row or re-ran non-idempotent DDL ("table
  already exists"), and the server exited at boot. A pending migration now takes the write lock
  (`BEGIN IMMEDIATE`, waiting out `db.busyTimeoutMs`) and re-reads `schema_migrations` under it, so a
  process that lost the race skips what the winner applied and carries on; a warm boot still takes no
  lock. The same cold boot could also fail with `database is locked` while every process converted the
  new file to WAL: SQLite does not call the busy handler when waiting could deadlock, so the three
  adapters now retry that pragma until `db.busyTimeoutMs` is spent. Covers cache.db, experiential.db and
  auth.db (all go through `runMigrations`). `test/migrate-cold-boot-race.test.ts` boots 4 real
  processes against a fresh directory 50 times per chain; before the fix cache.db and experiential.db
  failed 50 of 50 iterations and auth.db about half. (#1052)
