---
type: Added
---
- **Vault conventions: a `severity: block` rule refuses a write that adds its violation.** A write whose note would gain a blocking folder-convention violation (a required property missing, or a value outside its allowed list) fails with `convention_blocked` before any byte reaches disk, and nothing is snapshotted or confirmed. A write that only fixes a note, or edits a note that already broke the rule, is never refused, and a `warn` rule still only warns. Restores and cross-note backlink rewrites stay warn-only.
