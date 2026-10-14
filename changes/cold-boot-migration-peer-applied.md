---
type: Fixed
---
- **Two servers starting together on an empty cache no longer crash on `schema_migrations`.** When another process has already applied a migration, the second one now skips it instead of exiting with `UNIQUE constraint failed: schema_migrations.version`. Refs #995
