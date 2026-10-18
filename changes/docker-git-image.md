---
type: Added
---
- **`-git` image variant.** `ghcr.io/the-40-thieves/obsidian-tc:<version>-git` (and `:latest-git` for a stable release) ships `git` and `openssh-client` and runs `obsidian-tc git-sync --supervise`: it clones the vault from `OBSIDIAN_TC_VAULT_GIT_URL`, keeps it in step with that remote, and serves it over MCP. The default image is unchanged and carries no Git tooling. `obsidian-tc git-sync --supervise` starts the server as a child, runs the sync loop beside it, and exits when either stops, so the platform restarts the container.
