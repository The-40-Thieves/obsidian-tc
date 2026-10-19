---
type: Fixed
---
- **A fresh data volume no longer stops the first boot.** When `OBSIDIAN_TC_VAULT_PATH` names a folder that does not exist yet and its parent does, the server creates it and logs one line, instead of exiting with `vault root could not be resolved`. A vault path written only in the config file still fails loudly when missing.
