---
type: Security
---
- **The authorization server's databases are owner-only, and a looser copy from an earlier version is tightened on upgrade.** `auth.db` and `oauth.db`, with their `-wal` and `-shm` files, are created 0600. A file an earlier version left readable by group or other is chmodded to 0600 on its next open, and the server writes one line to stderr naming it; nothing refuses to start. This is POSIX only: on Windows there is no owner-only mode, so protect `<cacheDir>` with its ACL. A signing-key file readable by others is still refused rather than tightened, because it may already have been read.
