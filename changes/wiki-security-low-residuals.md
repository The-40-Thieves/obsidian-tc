---
type: Security
config-schema-change: vaults.wiki.folder, vaults.wiki.rawFolder
---
- **Harden wiki writes and generated pages.** Generated `index.md` and `log.md` now use a per-server HMAC key stored in private server state, safely rebuild legacy SHA-sealed files without trusting their body or cursor, and regenerate off the `commit_wiki_page` request path. Batch provenance fails closed before renames and settles from the bytes the batch wrote; changeset deduplication follows filesystem identity; wiki folder globs escape metacharacters; and folder segments ending in a space or dot are rejected for Windows safety.
