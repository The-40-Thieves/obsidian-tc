---
type: Added
---
- **Vault conventions: `severity:` is read and reported.** A SCHEMA.md `conventions:` block may set `severity:` per frontmatter property (globally, and per type under `types`) to `warn` or `block`, with `"*"` as the default and `null` removing an inherited entry. `get_conventions` and `start_session` report each severity with its source. The level is enforced by the write gate: a `block` violation that a write adds refuses it with `convention_blocked`.
