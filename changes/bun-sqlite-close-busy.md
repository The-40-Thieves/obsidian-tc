---
type: Fixed
---
- **Offline CLI passes no longer exit 1 when the database is busy at close.** `note-quality` (and the other offline passes that share the bun:sqlite adapter) could report `database is locked` after their writes had committed, when another process held the same cache open. A close-time busy is now retried without the throw; any other close failure still fails the command. Refs #1259
