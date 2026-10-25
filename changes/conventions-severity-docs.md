---
type: Added
---
- **Vault conventions can block writes.** A SCHEMA.md `conventions:` block can set `severity:` per property, globally and per type, to `warn` or `block`. A write that adds a `block` violation is refused with `convention_blocked` and nothing is written, while a partial fix always passes. Moves and copies are judged against their source note under the source folder's rules, so moving a note into a stricter folder can be refused. `bulk_move_notes` with `dry_run` reports `would_block` for each row a real run would refuse. `lint_wiki` lists notes with blocking violations first and says how many are blocking. The rules, severity precedence and fail-open behaviour are in [Vault conventions](docs/src/content/docs/guides/vault-conventions.md).
