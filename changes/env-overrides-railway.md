---
type: Added
---
- **Environment overrides for container hosts.** `PORT`, `OBSIDIAN_TC_PUBLIC_URL`, `OBSIDIAN_TC_JWKS_URI`, `OBSIDIAN_TC_VAULT_PATH` and `OBSIDIAN_TC_CACHE_DIR` overlay the config file, so a deployment such as Railway can configure the server without editing it. Environment values win over the file. `PORT` turns on the HTTP transport unless the file disables it, and `OBSIDIAN_TC_VAULT_PATH` is refused when the config names several vaults. See the new Railway deployment page.
