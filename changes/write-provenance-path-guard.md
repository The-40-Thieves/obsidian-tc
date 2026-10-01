---
type: Fixed
---
- **A vault path segment that merely starts with `..` is no longer refused as traversal.** The shared write-path guard treated any path beginning with `..` as an escape, so a legitimate sibling such as `..notes/a.md` was refused. The check is now segment-aware: only a `..` segment escapes the vault, and real traversal and symlink escapes are still refused.
