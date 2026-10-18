---
type: Added
---
- **Git vault sync webhook.** `POST /hooks/vault-sync` lets a Git host (GitHub, Gitea, Forgejo or GitLab) ask the git-sync sidecar to pull now instead of waiting for the next interval. It is enabled only when `OBSIDIAN_TC_VAULT_GIT_WEBHOOK_SECRET` is set, to at least 32 characters, and it authenticates each call with an HMAC signature or a GitLab token. A valid call only touches the sync trigger file; it runs no git command and takes no input. Unset, the path is not routed at all. Like the sidecar, it supports Linux and macOS only: on Windows the server refuses to start while the secret is set.
