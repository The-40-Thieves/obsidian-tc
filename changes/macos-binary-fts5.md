---
type: Fixed
---
- **The macOS standalone binaries have full-text search again.** The SQLite embedded in the
  `darwin-arm64` and `darwin-x64` binaries was built without FTS5, so 2.0.0 and 2.0.1 logged
  `notes_fts failed: no such module: fts5` at startup and answered text searches from slower disk
  scans. The embedded SQLite is now built with FTS5, the build refuses a library that lacks it, and
  both the release smoke and the first-run matrix fail a build whose `notes_fts` is not available.
  Other install paths (npm, the `.mcpb` bundle, Docker, the Linux and Windows binaries) were not
  affected. Refs #1515.
