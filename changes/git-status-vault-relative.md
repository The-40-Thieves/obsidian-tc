---
type: Security
---
- **Keep Git paths inside the vault.** Status results are converted from repository-relative paths to vault-relative paths before ACL filtering, files outside a nested vault are omitted, and older companion installs receive an actionable update error instead of returning an ambiguous payload. Diff and stage inputs are mapped back to repository-relative paths; native Git receives literal pathspecs while the mobile backend receives exact filenames, so nested repositories work without wildcard expansion reaching denied files.
