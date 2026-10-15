---
type: Security
---
- **Refuse linked components in fallback vault reads.** Pure-JavaScript note, config, and attachment reads now reject symlinked or junctioned path components instead of following them outside the vault.
