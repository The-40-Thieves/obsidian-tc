---
type: Security
---
- **Refuse linked components in fallback vault reads.** Pure-JavaScript note, config, and attachment reads now reject every symlinked or junctioned path component, including unconfigured in-vault aliases such as `wiki -> pages`. A symlinked `.obsidian` directory or developer-symlinked plugin folder is therefore skipped on Windows and in other addon-less or forced-fallback deployments. On the native backend, a missing path reached through an unconfigured link now reports a refusal instead of not-found, so whether a file exists outside the vault no longer shows. A memory-import directory reached through a symlinked parent is now resolved before the walk; a directory that is itself a symlink is still refused.
