---
type: Fixed
---
- **HTTP and OAuth callers with no vault now land on the default vault.** An unbound token (no `vault` claim, no grant vault) was pinned to the first vault listed, so `OBSIDIAN_TC_DEFAULT_VAULT` named a vault the caller could not reach. It now follows the default, as the variable documents. A token that names a vault is unaffected.
