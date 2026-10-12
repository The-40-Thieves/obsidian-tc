---
type: Changed
tool-description-change: read_resources
---
- **Note resources serve every registered vault the caller may read.** For a trusted caller (stdio), `resources/read`, `resources/list` and `read_resources` now name any registered vault, each under that vault's own folder ACL, where they served only the default vault. A refusal in another vault (an unknown vault, a denied folder, a symbolic or hard link that escapes the read rule) answers exactly as a missing note does, so the URI cannot be used to learn which vaults or notes exist. A vault-bound caller (an HTTP token) is still confined to its own vault. To keep the old default-vault-only behaviour, set `resources.boundVaultOnly: true`.
