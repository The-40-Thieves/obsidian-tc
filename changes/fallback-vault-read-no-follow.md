---
type: Security
---
- **Refuse linked components in fallback vault reads.** Pure-JavaScript note, config, and attachment reads now reject every symlinked or junctioned path component, including unconfigured in-vault aliases such as `wiki -> pages`. A symlinked `.obsidian` directory or developer-symlinked plugin folder is therefore skipped on Windows and in other addon-less or forced-fallback deployments.
