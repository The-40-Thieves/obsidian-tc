---
type: Added
---
- **Vault conventions: `severity:` is read and reported.** A SCHEMA.md `conventions:` block may set `severity:` per frontmatter property (globally, and per type under `types`) to `warn` or `block`, with `"*"` as the default and `null` removing an inherited entry. `get_conventions` and `start_session` report each severity with its source. Nothing blocks a write yet: every violation still reports as a warning, and the level is what a later release will enforce.
