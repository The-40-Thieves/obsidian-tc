---
type: Added
---
- **Synchronize a Git-backed vault with the new POSIX-only (Linux, macOS) `obsidian-tc git-sync` sidecar command.** Intended for the `-git` container image, it clones or verifies the configured vault, batches local commits, rebases and pushes changes, preserves conflicts on rescue branches, and supports `--once` for cron-style operation.
